import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'
import type { WorkspaceRole } from '@hitly/core'
import { auth } from './auth'
import { WORKSPACE_COOKIE } from './context'
import { listUserWorkspaces } from './workspace'
import { withTenant } from './tenant'

export const WORKSPACE_HEADER = 'x-hitly-workspace-id'

type SessionUser = { id: string; name: string; email: string }

export type ApiSessionOk = {
  ok: true
  session: { user: SessionUser }
}

export type ApiErr = { ok: false; error: NextResponse }

export async function requireApiSession(): Promise<ApiSessionOk | ApiErr> {
  if (!auth) {
    return { ok: false, error: NextResponse.json({ error: 'Database not configured' }, { status: 503 }) }
  }
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return { ok: false, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  return {
    ok: true,
    session: { user: { id: session.user.id, name: session.user.name, email: session.user.email } },
  }
}

export async function requireApiWorkspace() {
  const authResult = await requireApiSession()
  if (!authResult.ok) return authResult

  const memberships = await listUserWorkspaces(authResult.session.user.id)
  if (memberships.length === 0) {
    return {
      ok: true as const,
      session: authResult.session,
      workspaces: memberships,
      workspace: null,
      role: null as WorkspaceRole | null,
    }
  }

  const headerStore = await headers()
  const cookieStore = await cookies()
  const requested = headerStore.get(WORKSPACE_HEADER)?.trim() || cookieStore.get(WORKSPACE_COOKIE)?.value
  const current = memberships.find((item) => item.id === requested) ?? memberships[0]
  return {
    ok: true as const,
    session: authResult.session,
    workspaces: memberships,
    workspace: current,
    role: current.role as WorkspaceRole,
  }
}

export type ApiWorkspaceOk = Extract<Awaited<ReturnType<typeof requireApiWorkspace>>, { ok: true }>
export type ApiTenantOk = ApiWorkspaceOk & {
  workspace: NonNullable<ApiWorkspaceOk['workspace']>
  role: NonNullable<ApiWorkspaceOk['role']>
}

export async function withApiTenant<T>(fn: (ctx: ApiTenantOk) => Promise<T>): Promise<T | NextResponse> {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return withTenant(ctx.workspace.id, () => fn(ctx as ApiTenantOk))
}
