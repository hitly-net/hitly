import { notFound } from 'next/navigation'
import { withAppTenant } from './context'
import { getProjectAccess } from './rbac'

export async function requireVisibleProject(projectId: string) {
  return withAppTenant(async (ctx) => {
    const access = await getProjectAccess({
      projectId,
      userId: ctx.user.id,
      workspaceRole: ctx.role,
    })
    if (!access || access.project.workspaceId !== ctx.workspace.id) notFound()
    return { ...ctx, access, project: access.project }
  })
}
