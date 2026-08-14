import { NextResponse } from 'next/server'
import { requireApiWorkspace } from './api-session'
import { canAdminProject, getProjectAccess } from './rbac'

export async function requireApiProject(projectId: string) {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx
  if (!ctx.workspace || !ctx.role) {
    return { ok: false as const, error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }
  const access = await getProjectAccess({
    projectId,
    userId: ctx.session.user.id,
    workspaceRole: ctx.role,
  })
  if (!access || access.project.workspaceId !== ctx.workspace.id) {
    return { ok: false as const, error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }
  return { ...ctx, access, canAdmin: canAdminProject(access) }
}
