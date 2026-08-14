import type { ApprovalEnvelope, ApprovalStatus, Decision, OriginRef, PluginId } from '@hitly/core'

export type InstanceConfig = {
  baseUrl: string
  label: string
}

export type SessionUser = {
  id: string
  name: string
  email: string
}

export type WorkspaceRow = {
  id: string
  name: string
  slug: string
  plan: string
  role: string
}

export type InboxSummary = {
  pending: number
  failedResume: number
  decidedToday: number
  projectCount: number
}

export type WorkItemRow = {
  id: string
  status: ApprovalStatus | string
  actionName: string
  plugin: PluginId | string
  projectId: string
  projectName: string
  createdAt: string
  expiresAt: string | null
  decision?: Decision | string | null
}

export type OriginField = { key: string; label: string; value: string }

export type DecisionRow = {
  id: string
  decision: Decision | string
  payload: Record<string, unknown>
  resumeError: string | null
  resumeResponse: Record<string, unknown> | null
  actorUserId: string | null
  createdAt: string
}

export type ApprovalDetail = {
  id: string
  status: ApprovalStatus | string
  actionName: string
  plugin: PluginId | string
  projectId: string
  projectName: string
  assignedUserId: string | null
  createdAt: string
  expiresAt: string | null
  envelope: ApprovalEnvelope
  origin: OriginRef
  originFields: OriginField[]
  canAct: boolean
  canCancel: boolean
  decisions: DecisionRow[]
}

export type WorkspaceSettings = {
  id: string
  name: string
  slug: string
  timezone: string
  defaultSlaMinutes: string
  plan: string
  role: string
  canManage: boolean
}

export type ProjectRow = {
  id: string
  name: string
  description: string | null
  plugin: PluginId | string
  canAdmin: boolean
}

export type ProjectPerson = {
  userId: string
  name: string | null
  email: string
}

export type ProjectConfig = {
  id: string
  name: string
  description: string
  plugin: PluginId | string
  defaultSlaMinutes: string
  defaultAssigneeUserId: string | null
  baseUrl: string
  address: string
  namespace: string
  taskQueue: string
  people: ProjectPerson[]
}

export type AttentionLink = {
  approvalId: string
  instanceUrl?: string
}
