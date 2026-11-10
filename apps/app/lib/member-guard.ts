/**
 * Last-admin / last-owner guard.
 *
 * Product rule: every project must always have at least one admin, and a
 * workspace must always keep at least one owner, so no one can lock
 * themselves (or the org) out of a project's People tab or a workspace.
 *
 * Callers run inside the tenant transaction (server actions go through
 * withAppTenant/withTenant, which wraps everything in one transaction), and
 * these guards take a per-project advisory transaction lock before counting,
 * the same house idiom as create-once in lib/approvals.ts. Two concurrent
 * demotions/removals therefore serialise: the loser recounts after the
 * winner commits and sees zero admins left, so exactly one change wins.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { ProjectRole } from '@hitly/core'
import { memberships, projectMemberships } from '@hitly/db/schema'
import { requireDb, requireTenantWorkspaceId, type TenantDatabase } from './tenant'

/** Stable error codes for "this change would leave a project with no admin". */
export const LAST_PROJECT_ADMIN = 'last_project_admin'
/** Stable error code for "this change would leave a workspace with no owner". */
export const LAST_WORKSPACE_OWNER = 'last_workspace_owner'

export class MembershipGuardError extends Error {
  readonly code: string
  /** HTTP status when surfaced from an API route (server actions throw). */
  readonly status = 409
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MembershipGuardError'
    this.code = code
  }
}

/**
 * Serialize last-admin checks for one project for the rest of the current
 * transaction (pg_advisory_xact_lock, same idiom as create-once).
 */
async function lockProjectAdminGuard(database: TenantDatabase, projectId: string) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`hitly:project-admin:${projectId}`}, 0))`,
  )
}

async function countOtherAdmins(
  database: TenantDatabase,
  workspaceId: string,
  projectId: string,
  excludeMembershipId: string,
): Promise<number> {
  const rows = await database
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.workspaceId, workspaceId),
        eq(projectMemberships.role, 'admin'),
      ),
    )
  return rows.filter((row) => row.id !== excludeMembershipId).length
}

/**
 * Refuse a role change or removal that would take a project to zero admins.
 *
 * Pass `newRole` for a role change and omit it for a removal. The membership
 * row is verified to belong to `projectId` in the tenant workspace here, so
 * callers get cross-project scoping for free. Non-admin rows never trip the
 * guard (promotions always pass, demotions of non-admins always pass).
 */
export async function guardProjectAdminChange(args: {
  projectId: string
  membershipId: string
  newRole?: ProjectRole
  database?: TenantDatabase
  workspaceId?: string
}): Promise<void> {
  const database = args.database ?? requireDb()
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  const rows = await database
    .select({
      id: projectMemberships.id,
      role: projectMemberships.role,
    })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.id, args.membershipId),
        eq(projectMemberships.projectId, args.projectId),
        eq(projectMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1)
  const member = rows[0]
  if (!member) throw new Error('Member not found')
  if (member.role !== 'admin') return
  if (args.newRole === 'admin') return
  await lockProjectAdminGuard(database, args.projectId)
  // Recount after acquiring the lock so a concurrent committed change wins.
  const remaining = await countOtherAdmins(database, workspaceId, args.projectId, member.id)
  if (remaining === 0) {
    throw new MembershipGuardError(
      LAST_PROJECT_ADMIN,
      'This is the project\'s only admin. Promote someone else to admin first.',
    )
  }
}

/**
 * Refuse removing a person from the workspace while they are the only admin
 * of some project in it: the removal would strand those projects without an
 * admin (their project memberships go away with their workspace access).
 *
 * Projects are locked in sorted order so concurrent removals cannot deadlock.
 */
export async function assertWorkspaceMemberRemovalKeepsProjectAdmins(args: {
  userId: string
  database?: TenantDatabase
  workspaceId?: string
}): Promise<void> {
  const database = args.database ?? requireDb()
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  const adminRows = await database
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.workspaceId, workspaceId),
        eq(projectMemberships.userId, args.userId),
        eq(projectMemberships.role, 'admin'),
      ),
    )
  const projectIds = [...new Set(adminRows.map((row) => row.projectId))].sort()
  for (const projectId of projectIds) {
    await lockProjectAdminGuard(database, projectId)
    // Recount after acquiring the lock so a concurrent committed change wins.
    const admins = await database
      .select({ userId: projectMemberships.userId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.projectId, projectId),
          eq(projectMemberships.workspaceId, workspaceId),
          eq(projectMemberships.role, 'admin'),
        ),
      )
    if (admins.length > 0 && admins.every((admin) => admin.userId === args.userId)) {
      throw new MembershipGuardError(
        LAST_PROJECT_ADMIN,
        'That person is the only admin of a project in this workspace. Promote someone else to project admin first.',
      )
    }
  }
}

/**
 * Refuse removing the workspace membership row that holds the last owner.
 * (The Team page never offers an owner removal; this is the server-side
 * backstop so the rule does not depend on the UI.)
 */
export async function assertWorkspaceKeepsOwner(args: {
  membershipId: string
  database?: TenantDatabase
  workspaceId?: string
}): Promise<void> {
  const database = args.database ?? requireDb()
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  const rows = await database
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, args.membershipId), eq(memberships.workspaceId, workspaceId)))
    .limit(1)
  const member = rows[0]
  if (!member) throw new Error('Member not found')
  if (member.role !== 'owner') return
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`hitly:workspace-owner:${workspaceId}`}, 0))`,
  )
  const owners = await database
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')))
  if (owners.length <= 1) {
    throw new MembershipGuardError(
      LAST_WORKSPACE_OWNER,
      'A workspace must keep at least one owner.',
    )
  }
}

/**
 * People tab: the admin role select and Remove are disabled for the row that
 * holds the project's only admin (the server-side guard is the real gate;
 * this only stops the dead-end click).
 */
export function isLastAdminRow(role: ProjectRole, adminCount: number): boolean {
  return role === 'admin' && adminCount <= 1
}
