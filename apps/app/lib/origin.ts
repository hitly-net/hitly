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
] as const

const HIDDEN = new Set(['mastraBaseUrl', 'resumeUrl', 'deploymentUrl', 'address', 'signal'])

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
    value('agentName') ?? value('agentId'),
    value('workflowName') ?? value('workflowId'),
    value('stepName') ?? value('stepId'),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}
