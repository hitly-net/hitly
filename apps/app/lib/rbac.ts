import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { projectMemberships, projects } from '@hitly/db/schema'
import { isWorkspaceAdmin, type ProjectRole, type WorkspaceRole } from '@hitly/core'
import { requireDb, requireTenantWorkspaceId, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'

export function canManageWorkspace(role: WorkspaceRole) {
  return isWorkspaceAdmin(role)
}

export async function getProjectAccess(args: {
  projectId: string
  userId: string
  workspaceRole: WorkspaceRole
}) {
  const workspaceId = requireTenantWorkspaceId()
  const database = requireDb()
  const projectRows = await database
    .select()
    .from(projects)
    .where(and(eq(projects.id, args.projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  const projectRow = projectRows[0]
  if (!projectRow) return null
  const project = {
    ...projectRow,
    credentials: await decodeTenantJson(projectRow.workspaceId, projectRow.credentials),
  }

  if (isWorkspaceAdmin(args.workspaceRole)) {
    return { project, projectRole: 'admin' as ProjectRole, implicit: true }
  }

  const memberRows = await database
    .select()
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, args.projectId),
        eq(projectMemberships.userId, args.userId),
        eq(projectMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1)
  const membership = memberRows[0]
  if (!membership) return null
  return { project, projectRole: membership.role, implicit: false }
}

export function canViewProject(access: { projectRole: ProjectRole } | null) {
  return Boolean(access)
}

export function canDecide(access: { projectRole: ProjectRole } | null) {
  return access?.projectRole === 'admin' || access?.projectRole === 'user'
}

export function canAdminProject(access: { projectRole: ProjectRole } | null) {
  return access?.projectRole === 'admin'
}

export async function listVisibleProjectIds(args: {
  workspaceId: string
  userId: string
  workspaceRole: WorkspaceRole
  /** Archived projects are hidden from inbox and lists unless this is set. */
  includeArchived?: boolean
}) {
  return withTenant(args.workspaceId, async () => {
    const database = requireDb()
    const scope = [eq(projects.workspaceId, args.workspaceId)]
    if (!args.includeArchived) scope.push(ne(projects.status, 'archived'))
    if (isWorkspaceAdmin(args.workspaceRole)) {
      const rows = await database.select({ id: projects.id }).from(projects).where(and(...scope))
      return rows.map((row) => row.id)
    }
    const rows = await database
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
      .where(and(...scope, eq(projectMemberships.userId, args.userId)))
    return rows.map((row) => row.id)
  })
}

export async function listVisibleProjects(args: {
  workspaceId: string
  userId: string
  workspaceRole: WorkspaceRole
}) {
  const ids = await listVisibleProjectIds(args)
  if (ids.length === 0) return []
  return withTenant(args.workspaceId, async () =>
    requireDb()
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projects)
      .where(and(eq(projects.workspaceId, args.workspaceId), inArray(projects.id, ids)))
      .orderBy(asc(projects.name)),
  )
}

/** Workspace admins only: archived projects for unarchive/delete. Members get []. */
export async function listArchivedProjects(args: {
  workspaceId: string
  workspaceRole: WorkspaceRole
}) {
  if (!isWorkspaceAdmin(args.workspaceRole)) return []
  return withTenant(args.workspaceId, async () =>
    requireDb()
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        plugin: projects.plugin,
        status: projects.status,
      })
      .from(projects)
      .where(and(eq(projects.workspaceId, args.workspaceId), eq(projects.status, 'archived')))
      .orderBy(asc(projects.name)),
  )
}
