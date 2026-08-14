'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { WORKSPACE_COOKIE, getAppContext } from '@/lib/context'
import { canManageWorkspace } from '@/lib/rbac'
import { parseWorkspaceSettings, saveWorkspaceSettings } from '@/lib/workspace-settings'

export async function switchWorkspace(workspaceId: string, nextPath = '/') {
  const { workspaces: list } = await getAppContext()
  if (!list.some((item) => item.id === workspaceId)) {
    throw new Error('Not a member of that workspace')
  }
  const cookieStore = await cookies()
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, { path: '/', sameSite: 'lax' })
  revalidatePath('/')
  redirect(nextPath)
}

export async function updateWorkspace(formData: FormData) {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can update workspace settings')
  }
  const parsed = parseWorkspaceSettings({
    name: formData.get('name'),
    timezone: formData.get('timezone'),
    sla: formData.get('sla'),
  })
  if ('error' in parsed) throw new Error(parsed.error)
  await saveWorkspaceSettings(workspace.id, parsed)
  revalidatePath('/settings/workspace')
}
