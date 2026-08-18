import type { Decision } from './index'

export const EVIDENCE_SPEC_VERSION = 'hitly.evidence.v1'

export type EvidenceEventType = 'requested' | 'presented' | 'decided' | 'resumed' | 'resume_failed'

export interface EvidenceOriginContext {
  plugin: string
  projectId: string
  runId: string
  stepId?: string
}

export interface EvidenceAgentContext {
  agentId?: string
  traceId?: string
  spanId?: string
}

export interface EvidenceSystemContext {
  systemId?: string
  inventoryId?: string
}

export interface EvidencePolicyContext {
  policyId?: string
  policyRationale?: string
  riskTier?: string
}

export interface EvidenceActionProposal {
  name: string
  args: Record<string, unknown>
  proposed_sha256: string
}

export interface EvidenceActionFinal {
  name: string
  args: Record<string, unknown>
  final_sha256: string
  delta?: Record<string, unknown>
}

export interface EvidenceOversight {
  reviewer_id?: string
  decision?: Decision
  decided_at?: string
}

export interface EvidenceRetention {
  min_days: number
  expires_at?: string
}

export interface EvidenceIntegrity {
  alg: 'sha256'
  prev_event_id?: string
  prev_content_sha256?: string
  content_sha256: string
}

export interface EvidenceEvent {
  spec: string
  event_id: string
  approval_id: string
  event_type: EvidenceEventType
  seq: number
  occurred_at: string

  origin: EvidenceOriginContext
  agent?: EvidenceAgentContext
  system?: EvidenceSystemContext
  policy?: EvidencePolicyContext

  action: EvidenceActionProposal | EvidenceActionFinal
  oversight?: EvidenceOversight
  retention: EvidenceRetention
  integrity: EvidenceIntegrity

  toolName?: string
  sensitivity?: string[]
  dataCategories?: string[]
}

export interface AppendReceipt {
  event_id: string
  content_sha256: string
  store_uri: string
  stored_at: string
}

export interface EvidenceSink {
  id: 'none' | 'http'
  append(event: EvidenceEvent): Promise<AppendReceipt>
}

function sortedKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortedKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortedKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortedKeys(obj))
}

export async function sha256Hex(input: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(input)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export async function hashEvidenceContent(event: EvidenceEvent): Promise<string> {
  const copy = { ...event, integrity: { ...event.integrity, content_sha256: '' } }
  const canonical = canonicalJson(copy)
  return sha256Hex(canonical)
}

export async function hashActionArgs(args: Record<string, unknown>): Promise<string> {
  const canonical = canonicalJson(args)
  return sha256Hex(canonical)
}
