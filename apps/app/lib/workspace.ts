import { and, eq, isNull } from 'drizzle-orm'
import { defaultWorkspacePlan } from '@hitly/cloud/auth/providers'
import { invites, memberships, users, workspaces } from '@hitly/db/schema'
import { newId, slugify } from './ids'
import { requireDb } from './require-db'

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
  }

  const pending = await database
    .select()
    .from(invites)
    .where(and(eq(invites.email, user.email.toLowerCase()), isNull(invites.acceptedAt)))

  for (const invite of pending) {
    if (invite.expiresAt.getTime() < Date.now()) continue
    const already = await database
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, invite.workspaceId), eq(memberships.userId, user.id)))
      .limit(1)
    if (already.length === 0 && invite.role !== 'owner') {
      await database.insert(memberships).values({
        id: newId('mem').slice(0, 36),
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: invite.role === 'admin' ? 'admin' : 'member',
      })
    }
    await database.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id))
  }
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
