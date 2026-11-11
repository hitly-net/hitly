import type { AnswerSchema, ApprovalEnvelope, ApprovalStatus, Decision, OriginRef, PluginId } from '@hitly/core'

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
  /** 'question' for ask_user rows (host list), 'approval' otherwise. */
  kind?: 'question' | 'approval'
  /** ask_user headline; titles the row when present. */
  prompt?: string | null
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
  /** hitl-spec 4.3: ISO when first shown to a reviewer who can decide; null if never. */
  presentedAt?: string | null
  /**
   * Stored ask_user schema (hitl-spec 3.4), also nested on `envelope.answerSchema`.
   * Null when the request has none (legacy asks). Always present on GET /api/v1/approvals/:id.
   */
  answerSchema: AnswerSchema | null
  envelope: ApprovalEnvelope
  origin: OriginRef
  originFields: OriginField[]
  canAct: boolean
  canCancel: boolean
  /**
   * Gating refs (hitl-spec 3.7) THIS reviewer has recorded opens for. The detail
   * screen hydrates its mustOpen checklist from these, so re-entering an approval
   * does not force opening every item again (hitly#96 S10).
   */
  openedRefs?: string[]
  decisions: DecisionRow[]
  evidenceReceipt?: { storeUri: string }
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
