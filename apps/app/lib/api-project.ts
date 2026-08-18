import { NextResponse } from 'next/server'
import { withApiTenant } from './api-session'
import { canAdminProject, getProjectAccess } from './rbac'

export async function requireApiProject(projectId: string) {
  const result = await withApiTenant(async (ctx) => {
    const access = await getProjectAccess({
      projectId,
      userId: ctx.session.user.id,
      workspaceRole: ctx.role,
    })
    if (!access || access.project.workspaceId !== ctx.workspace.id) {
      return { ok: false as const, error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
    }
    return { ...ctx, access, canAdmin: canAdminProject(access) }
  })
  if (result instanceof NextResponse) {
    return { ok: false as const, error: result }
  }
  return result
}
