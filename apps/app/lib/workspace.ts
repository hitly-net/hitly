import { eq } from 'drizzle-orm'
import { defaultWorkspacePlan } from '@hitly/cloud/auth/providers'
import { edition } from '@hitly/cloud'
import { memberships, users, workspaces } from '@hitly/db/schema'
import { newId, slugify } from './ids'
import { requireDb } from './tenant'

export async function bootstrapUserWorkspaces(user: { id: string; name: string; email: string }) {
  const database = requireDb()
  const existing = await database
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1)
  if (existing.length === 0) {
    const workspaceId = newId('ws').slice(0, 36)
    await database.insert(workspaces).values({
      id: workspaceId,
      name: `${user.name}'s workspace`,
      slug: `${slugify(user.name)}-${workspaceId.slice(-8)}`,
      plan: defaultWorkspacePlan,
    })
    await database.insert(memberships).values({
      id: newId('mem').slice(0, 36),
      workspaceId,
      userId: user.id,
      role: 'owner',
    })
    await edition.onWorkspaceCreated?.(workspaceId)
  }

  // Workspace invites are accepted only through the tokenised link in the
  // invite email (lib/invites.ts). They are no longer applied by matching the
  // account email here: that let anyone who signed up with an address (no
  // proof of ownership) join the workspaces it had been invited to.
}

export async function listUserWorkspaces(userId: string) {
  const database = requireDb()
  return database
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      plan: workspaces.plan,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId))
}

export async function findUserByEmail(email: string) {
  const database = requireDb()
  const rows = await database.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)
  return rows[0] ?? null
}
