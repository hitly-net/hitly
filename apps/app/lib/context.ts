import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { memberships, workspaces } from '@hitly/db/schema'
import type { WorkspaceRole } from '@hitly/core'
import { auth } from './auth'
import { bootstrapUserWorkspaces, listUserWorkspaces } from './workspace'
import { requireDb, withTenant } from './tenant'

export const WORKSPACE_COOKIE = 'hitly-workspace-id'

export async function getSessionUser() {
  if (!auth) return null
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return session.user
}

export async function requireSessionUser() {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  return user
}

export async function getAppContext() {
  const user = await requireSessionUser()
  let membershipList = await listUserWorkspaces(user.id)
  if (membershipList.length === 0) {
    await bootstrapUserWorkspaces({ id: user.id, name: user.name, email: user.email })
    membershipList = await listUserWorkspaces(user.id)
  }
  if (membershipList.length === 0) {
    redirect('/login')
  }
  const cookieStore = await cookies()
  const requested = cookieStore.get(WORKSPACE_COOKIE)?.value
  const current = membershipList.find((item) => item.id === requested) ?? membershipList[0]
  return {
    user,
    workspaces: membershipList,
    workspace: current,
    role: current.role as WorkspaceRole,
  }
}

export async function getWorkspaceRecord(workspaceId: string) {
  const database = requireDb()
  const rows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  return rows[0] ?? null
}

export async function getMembership(workspaceId: string, userId: string) {
  const database = requireDb()
  const rows = await database
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

export async function withAppTenant<T>(fn: (ctx: Awaited<ReturnType<typeof getAppContext>>) => Promise<T>) {
  const ctx = await getAppContext()
  return withTenant(ctx.workspace.id, () => fn(ctx))
}
