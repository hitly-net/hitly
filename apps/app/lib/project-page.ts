import { notFound } from 'next/navigation'
import { getAppContext } from './context'
import { getProjectAccess } from './rbac'

export async function requireVisibleProject(projectId: string) {
  const ctx = await getAppContext()
  const access = await getProjectAccess({
    projectId,
    userId: ctx.user.id,
    workspaceRole: ctx.role,
  })
  if (!access || access.project.workspaceId !== ctx.workspace.id) notFound()
  return { ...ctx, access, project: access.project }
}
