import { isWorkspaceAdmin } from '@hitly/core'
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
    // Archived projects are hidden from members; workspace admins can still open them to unarchive.
    if (access.project.status === 'archived' && !isWorkspaceAdmin(ctx.role)) notFound()
    return { ...ctx, access, project: access.project }
  })
}
