import type { OriginRef } from '@hitly/core'

const LABELS: Record<string, string> = {
  kind: 'Kind',
  agentName: 'Agent',
  agentId: 'Agent ID',
  workflowName: 'Workflow',
  workflowId: 'Workflow ID',
  stepName: 'Step',
  stepId: 'Step ID',
  toolCallId: 'Tool call',
  runId: 'Run',
  threadId: 'Thread',
  executionId: 'Execution',
  graphId: 'Graph',
  assistantId: 'Assistant',
  namespace: 'Namespace',
  resourceId: 'Resource',
  surface: 'Surface',
  sessionKey: 'Session',
  patternKey: 'Pattern',
  taskId: 'Task',
  profileName: 'Profile',
  kanbanStatus: 'Kanban',
  blockKind: 'Block kind',
  pageId: 'Page',
}

const ORDER = [
  'kind',
  'agentName',
  'agentId',
  'workflowName',
  'workflowId',
  'stepName',
  'stepId',
  'toolCallId',
  'runId',
  'threadId',
  'executionId',
  'graphId',
  'assistantId',
  'resourceId',
  'namespace',
  'surface',
  'sessionKey',
  'patternKey',
  'profileName',
  'taskId',
  'kanbanStatus',
  'blockKind',
  'pageId',
] as const

const HIDDEN = new Set(['mastraBaseUrl', 'resumeUrl', 'deploymentUrl', 'address', 'signal', 'metadata', 'cbAuthToken', 'cb_auth_token', 'lifecycleEvents', 'deliveryEventIds', 'idempotencyKey'])

/**
 * Bag keys that hold credentials (M0h cb_auth_token et al.). They live on the
 * approvals.origin column only — never in the stored create-once envelope and
 * never in a reader projection (spec: "never echo it in reads"). Mirrors
 * @hitly/plugin-http SECRET_HANDLE_KEYS; kept local so the host stays plugin-agnostic.
 */
const SECRET_BAG_KEYS = new Set(['cbAuthToken', 'cb_auth_token', 'authorization', 'authHeader'])

/** Deep copy of an origin/envelope bag with credential keys dropped at every depth. */
export function stripOriginSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripOriginSecrets(item)) as unknown as T
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_BAG_KEYS.has(key) || key.toLowerCase() === 'authorization') continue
    out[key] = stripOriginSecrets(child)
  }
  return out as unknown as T
}

function take(target: Record<string, string>, key: string, value: unknown) {
  if (typeof value === 'string' && value.trim()) target[key] = value.trim()
}

export function asOriginRef(value: unknown): OriginRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.plugin !== 'string') return null
  return record as unknown as OriginRef
}

export function originFields(origin: OriginRef): { key: string; label: string; value: string }[] {
  const handle = origin.resumeHandle ?? {}
  const merged: Record<string, string> = {}
  take(merged, 'kind', handle.kind)
  take(merged, 'agentName', handle.agentName)
  take(merged, 'agentId', handle.agentId)
  take(merged, 'workflowName', handle.workflowName)
  take(merged, 'workflowId', handle.workflowId)
  take(merged, 'stepName', handle.stepName)
  take(merged, 'stepId', origin.stepId ?? handle.stepId)
  take(merged, 'toolCallId', handle.toolCallId)
  take(merged, 'runId', origin.runId ?? handle.runId)
  take(merged, 'threadId', handle.threadId)
  take(merged, 'executionId', handle.executionId)
  take(merged, 'graphId', handle.graphId)
  take(merged, 'assistantId', handle.assistantId)
  take(merged, 'namespace', handle.namespace)
  take(merged, 'resourceId', handle.resourceId)
  take(merged, 'surface', handle.surface)
  take(merged, 'sessionKey', handle.sessionKey)
  take(merged, 'patternKey', handle.patternKey)
  take(merged, 'taskId', handle.taskId)
  take(merged, 'profileName', handle.profileName)
  take(merged, 'kanbanStatus', handle.kanbanStatus)
  take(merged, 'blockKind', handle.blockKind)
  if (!merged.kind && merged.agentId) merged.kind = 'agent'
  if (!merged.kind && merged.workflowId) merged.kind = 'workflow'
  if (origin.details) {
    for (const [key, value] of Object.entries(origin.details)) take(merged, key, value)
  }

  const rows: { key: string; label: string; value: string }[] = []
  const seen = new Set<string>()
  for (const key of ORDER) {
    if (!merged[key] || HIDDEN.has(key)) continue
    rows.push({ key, label: LABELS[key] ?? key, value: merged[key] })
    seen.add(key)
  }
  for (const [key, value] of Object.entries(merged)) {
    if (seen.has(key) || HIDDEN.has(key)) continue
    rows.push({ key, label: LABELS[key] ?? key, value })
  }
  return rows
}

export function originSummary(origin: OriginRef): string | null {
  const fields = originFields(origin)
  if (fields.length === 0) return null
  const value = (key: string) => fields.find((field) => field.key === key)?.value
  const parts = [
    value('kind'),
    value('agentName') ?? value('agentId') ?? value('profileName'),
    value('workflowName') ?? value('workflowId'),
    value('stepName') ?? value('stepId') ?? value('taskId'),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Envelope metadata, falling back to HTTP resumeHandle for items ingested before metadata was first-class. */
export function envelopeMetadata(
  envelope: { metadata?: Record<string, unknown> },
  origin: OriginRef,
): Record<string, unknown> {
  const fromEnvelope = asRecord(envelope.metadata)
  // Credential-shaped keys (cb_auth_token et al.) must never reach a reviewer
  // projection through the metadata bag, whatever path it was stored through.
  if (Object.keys(fromEnvelope).length > 0) return stripOriginSecrets(fromEnvelope)
  return stripOriginSecrets(asRecord(origin.resumeHandle?.metadata))
}
