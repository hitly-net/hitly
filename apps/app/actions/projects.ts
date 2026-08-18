'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { isOpenApprovalStatus, isPluginId, isProjectRole } from '@hitly/core'
import {
  approvals,
  projectApiKeys,
  projectChannels,
  projectMemberships,
  projectRules,
  projects,
  users,
} from '@hitly/db/schema'
import { getAppContext, withAppTenant } from '@/lib/context'
import { generateApiKey, generateResumeSecret } from '@/lib/keys'
import { newId } from '@/lib/ids'
import { parseProjectConfig, saveProjectConfig } from '@/lib/project-config'
import { canAdminProject, canDecide, canManageWorkspace, getProjectAccess } from '@/lib/rbac'
import { requireDb, requireTenantWorkspaceId } from '@/lib/tenant'
import { encodeTenantJson } from '@/lib/tenant-crypto'

function revalidateWorkItem(approvalId: string, projectId: string) {
  revalidatePath('/inbox')
  revalidatePath(`/inbox/${approvalId}`)
  revalidatePath(`/projects/${projectId}`)
  revalidatePath(`/projects/${projectId}/item/${approvalId}`)
}

function workItemReturnPath(formData: FormData, approval: { id: string; projectId: string }) {
  const value = String(formData.get('returnTo') ?? '')
  const allowed = new Set([
    `/inbox/${approval.id}`,
    `/projects/${approval.projectId}`,
    `/projects/${approval.projectId}/item/${approval.id}`,
  ])
  return allowed.has(value) ? value : `/inbox/${approval.id}`
}

function throwUnlessConflict(result: { error?: string; status?: number | string }) {
  if (result.error && result.status !== 409) throw new Error(result.error)
}

async function requireProjectAdmin(projectId: string) {
  const ctx = await getAppContext()
  const access = await getProjectAccess({
    projectId,
    userId: ctx.user.id,
    workspaceRole: ctx.role,
  })
  if (!access || access.project.workspaceId !== ctx.workspace.id || !canAdminProject(access)) {
    throw new Error('Forbidden')
  }
  return { ...ctx, access }
}

export async function createProject(formData: FormData) {
  return withAppTenant(async ({ user, workspace, role }) => {
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can create projects')
  }
  const name = String(formData.get('name') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim()
  const plugin = String(formData.get('plugin') ?? '')
  if (!name) throw new Error('Name is required')
  if (!isPluginId(plugin)) throw new Error('Choose a plugin')

  const database = requireDb()
  const projectId = newId('prj').slice(0, 36)
  await database.insert(projects).values({
    id: projectId,
    workspaceId: workspace.id,
    name,
    description: description || null,
    plugin,
    credentials: await encodeTenantJson(workspace.id, { plugin, resumeSecret: generateResumeSecret() }),
    defaultAssigneeUserId: user.id,
    defaultSlaMinutes: '60',
  })
  await database.insert(projectMemberships).values({
    id: newId('pm').slice(0, 36),
    workspaceId: workspace.id,
    projectId,
    userId: user.id,
    role: 'admin',
  })
  await database.insert(projectChannels).values({
    id: newId('ch').slice(0, 36),
    workspaceId: workspace.id,
    projectId,
    type: 'email',
    config: {},
    enabled: true,
  })
  revalidatePath('/projects')
  redirect(`/projects/${projectId}/config`)
  })
}

export async function updateProjectConfig(projectId: string, formData: FormData) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const parsed = parseProjectConfig({
      name: formData.get('name'),
      description: formData.get('description'),
      sla: formData.get('sla'),
      baseUrl: formData.get('baseUrl'),
      token: formData.get('token'),
      namespace: formData.get('namespace'),
      taskQueue: formData.get('taskQueue'),
      address: formData.get('address'),
      defaultAssigneeUserId: formData.get('defaultAssigneeUserId'),
      evidenceSinkType: formData.get('evidenceSinkType'),
      evidenceSinkUrl: formData.get('evidenceSinkUrl'),
      evidenceSinkAuthHeader: formData.get('evidenceSinkAuthHeader'),
    })
    if ('error' in parsed) throw new Error(parsed.error)
    const result = await saveProjectConfig(projectId, parsed)
    if ('error' in result) throw new Error(result.error)
    revalidatePath(`/projects/${projectId}`)
    revalidatePath(`/projects/${projectId}/config`)
  })
}

export async function createProjectApiKey(projectId: string, formData: FormData) {
  return withAppTenant(async ({ workspace }) => {
    await requireProjectAdmin(projectId)
    const name = String(formData.get('name') ?? 'Ingest key').trim() || 'Ingest key'
    const generated = generateApiKey()
    const database = requireDb()
    await database.insert(projectApiKeys).values({
      id: newId('key').slice(0, 36),
      workspaceId: workspace.id,
      projectId,
      name,
      hashedKey: generated.hashed,
      prefix: generated.prefix,
    })
    revalidatePath(`/projects/${projectId}`)
    revalidatePath(`/projects/${projectId}/config`)
    return generated.raw
  })
}

async function requireProjectApiKey(projectId: string, keyId: string) {
  const database = requireDb()
  const rows = await database
    .select({ id: projectApiKeys.id })
    .from(projectApiKeys)
    .where(and(eq(projectApiKeys.id, keyId), eq(projectApiKeys.projectId, projectId), eq(projectApiKeys.workspaceId, requireTenantWorkspaceId())))
    .limit(1)
  if (!rows[0]) throw new Error('Key not found')
  return database
}

export async function deleteProjectApiKey(projectId: string, keyId: string) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const database = await requireProjectApiKey(projectId, keyId)
    await database.delete(projectApiKeys).where(and(eq(projectApiKeys.id, keyId), eq(projectApiKeys.workspaceId, requireTenantWorkspaceId())))
    revalidatePath(`/projects/${projectId}`)
    revalidatePath(`/projects/${projectId}/config`)
  })
}

export async function regenerateProjectApiKey(projectId: string, keyId: string) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const database = await requireProjectApiKey(projectId, keyId)
    const generated = generateApiKey()
    await database
      .update(projectApiKeys)
      .set({
        hashedKey: generated.hashed,
        prefix: generated.prefix,
        lastUsedAt: null,
      })
      .where(and(eq(projectApiKeys.id, keyId), eq(projectApiKeys.workspaceId, requireTenantWorkspaceId())))
    revalidatePath(`/projects/${projectId}`)
    revalidatePath(`/projects/${projectId}/config`)
    return generated.raw
  })
}

export async function regenerateProjectResumeSecret(projectId: string) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const { rotateProjectResumeSecret } = await import('@/lib/resume-secret')
    const result = await rotateProjectResumeSecret(projectId)
    if ('error' in result) throw new Error(result.error)
    const { logProjectEvent } = await import('@/lib/events')
    await logProjectEvent({
      projectId,
      type: 'config',
      message: 'Rotated resume secret',
    })
    revalidatePath(`/projects/${projectId}`)
    revalidatePath(`/projects/${projectId}/config`)
    return result.resumeSecret
  })
}

export async function addProjectMember(projectId: string, formData: FormData) {
  return withAppTenant(async ({ workspace }) => {
    await requireProjectAdmin(projectId)
    const userId = String(formData.get('userId') ?? '').trim()
    const role = String(formData.get('role') ?? 'user')
    if (!userId) throw new Error('Choose a person')
    if (!isProjectRole(role)) throw new Error('Invalid role')
    const database = requireDb()
    const existing = await database
      .select({ id: projectMemberships.id })
      .from(projectMemberships)
      .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId), eq(projectMemberships.workspaceId, workspace.id)))
      .limit(1)
    if (existing.length > 0) throw new Error('Already on this project')
    await database.insert(projectMemberships).values({
      id: newId('pm').slice(0, 36),
      workspaceId: workspace.id,
      projectId,
      userId,
      role,
    })
    revalidatePath(`/projects/${projectId}/people`)
  })
}

export async function updateProjectMemberRole(projectId: string, membershipId: string, formData: FormData) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const role = String(formData.get('role') ?? '')
    if (!isProjectRole(role)) throw new Error('Invalid role')
    const database = requireDb()
    await database.update(projectMemberships).set({ role }).where(and(eq(projectMemberships.id, membershipId), eq(projectMemberships.workspaceId, requireTenantWorkspaceId())))
    revalidatePath(`/projects/${projectId}/people`)
  })
}

export async function removeProjectMember(projectId: string, membershipId: string) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const database = requireDb()
    await database.delete(projectMemberships).where(and(eq(projectMemberships.id, membershipId), eq(projectMemberships.workspaceId, requireTenantWorkspaceId())))
    revalidatePath(`/projects/${projectId}/people`)
  })
}

export async function createProjectRule(projectId: string, formData: FormData) {
  return withAppTenant(async ({ workspace }) => {
    await requireProjectAdmin(projectId)
    const name = String(formData.get('name') ?? '').trim()
    const actionName = String(formData.get('actionName') ?? '').trim()
    const workflowId = String(formData.get('workflowId') ?? '').trim()
    const slaMinutes = Number(formData.get('slaMinutes') ?? '')
    const priority = Number(formData.get('priority') ?? 100)
    if (!name) throw new Error('Name is required')
    const database = requireDb()
    await database.insert(projectRules).values({
      id: newId('rul').slice(0, 36),
      workspaceId: workspace.id,
      projectId,
      name,
      priority: Number.isFinite(priority) ? priority : 100,
      match: {
        ...(actionName ? { actionName } : {}),
        ...(workflowId ? { workflowId } : {}),
      },
      actions: {
        ...(Number.isFinite(slaMinutes) && slaMinutes > 0 ? { slaMinutes } : {}),
        channelTypes: ['email'],
      },
      enabled: true,
    })
    revalidatePath(`/projects/${projectId}/rules`)
  })
}

export async function deleteProjectRule(projectId: string, ruleId: string) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const database = requireDb()
    await database.delete(projectRules).where(and(eq(projectRules.id, ruleId), eq(projectRules.workspaceId, requireTenantWorkspaceId())))
    revalidatePath(`/projects/${projectId}/rules`)
  })
}

export async function toggleProjectChannel(projectId: string, channelId: string, enabled: boolean) {
  return withAppTenant(async () => {
    await requireProjectAdmin(projectId)
    const database = requireDb()
    await database.update(projectChannels).set({ enabled, updatedAt: new Date() }).where(and(eq(projectChannels.id, channelId), eq(projectChannels.workspaceId, requireTenantWorkspaceId())))
    revalidatePath(`/projects/${projectId}/channels`)
  })
}

export async function retryWorkItem(approvalId: string) {
  return withAppTenant(async ({ user, role, workspace }) => {
    const database = requireDb()
    const approvalRows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspace.id)))
      .limit(1)
    const approval = approvalRows[0]
    if (!approval) throw new Error('Not found')
    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: user.id,
      workspaceRole: role,
    })
    if (!canDecide(access)) throw new Error('You cannot retry this work item')
    const { retryResume } = await import('@/lib/approvals')
    const result = await retryResume({ approvalId, workspaceId: workspace.id })
    throwUnlessConflict(result)
    revalidateWorkItem(approvalId, approval.projectId)
  })
}

export async function cancelWorkItem(approvalId: string) {
  return withAppTenant(async ({ user, role, workspace }) => {
    const database = requireDb()
    const approvalRows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspace.id)))
      .limit(1)
    const approval = approvalRows[0]
    if (!approval) throw new Error('Not found')
    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: user.id,
      workspaceRole: role,
    })
    if (!canDecide(access)) throw new Error('You cannot cancel this work item')
    const { cancelApproval } = await import('@/lib/approvals')
    const result = await cancelApproval({ approvalId, actorUserId: user.id, workspaceId: workspace.id })
    throwUnlessConflict(result)
    revalidateWorkItem(approvalId, approval.projectId)
  })
}

export async function delegateWorkItem(approvalId: string, formData: FormData) {
  return withAppTenant(async ({ user, role, workspace }) => {
    const userId = String(formData.get('userId') ?? '').trim()
    if (!userId) throw new Error('Choose a person')

    const database = requireDb()
    const approvalRows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspace.id)))
      .limit(1)
    const approval = approvalRows[0]
    if (!approval) throw new Error('Not found')
    if (!isOpenApprovalStatus(approval.status)) {
      throw new Error('Only open work items can be delegated')
    }

    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: user.id,
      workspaceRole: role,
    })
    if (!canDecide(access)) throw new Error('You cannot delegate this work item')
    if (userId === approval.assignedUserId) throw new Error('Already assigned to that person')

    const memberRows = await database
      .select()
      .from(projectMemberships)
      .where(and(eq(projectMemberships.projectId, approval.projectId), eq(projectMemberships.userId, userId), eq(projectMemberships.workspaceId, workspace.id)))
      .limit(1)
    const member = memberRows[0]
    if (!member || member.role === 'reader') {
      throw new Error('That person cannot decide this work item')
    }

    await database.update(approvals).set({ assignedUserId: userId, updatedAt: new Date() }).where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspace.id)))

    const { logProjectEvent } = await import('@/lib/events')
    const { notifyAssignee } = await import('@/lib/notify')
    const assigneeRows = await database.select().from(users).where(eq(users.id, userId)).limit(1)
    const assignee = assigneeRows[0]
    await logProjectEvent({
      projectId: approval.projectId,
      approvalId: approval.id,
      type: 'delegated',
      message: `Delegated to ${assignee?.name ?? assignee?.email ?? userId}`,
      payload: { fromUserId: approval.assignedUserId, toUserId: userId, byUserId: user.id },
    })
    await notifyAssignee({
      projectId: approval.projectId,
      approvalId: approval.id,
      assignedUserId: userId,
      actionName: approval.actionName,
      channelTypes: ['email'],
    })

    revalidateWorkItem(approvalId, approval.projectId)
  })
}

export async function decideWorkItem(approvalId: string, formData: FormData) {
  return withAppTenant(async ({ user, role, workspace }) => {
    const database = requireDb()
    const approvalRows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspace.id)))
      .limit(1)
    const approval = approvalRows[0]
    if (!approval) throw new Error('Not found')
    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: user.id,
      workspaceRole: role,
    })
    if (!canDecide(access)) throw new Error('You cannot decide this work item')
    const decision = String(formData.get('decision') ?? '')
    const response = String(formData.get('response') ?? '').trim()
    const editedRaw = String(formData.get('editedArgs') ?? '').trim()
    let editedArgs: Record<string, unknown> | undefined
    if (editedRaw) {
      editedArgs = JSON.parse(editedRaw) as Record<string, unknown>
    }
    const { decideApproval, parseDecisionBody } = await import('@/lib/approvals')
    const payload = parseDecisionBody({ decision, response: response || undefined, editedArgs })
    if (!payload) throw new Error('Invalid decision')
    const result = await decideApproval({ approvalId, actorUserId: user.id, payload, workspaceId: workspace.id })
    throwUnlessConflict(result)
    revalidateWorkItem(approvalId, approval.projectId)
    redirect(workItemReturnPath(formData, approval))
  })
}

