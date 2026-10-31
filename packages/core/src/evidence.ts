import type { Decision } from './index.ts'

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

/** Actor kinds mirror hitl-spec `decidedBy.kind` (SPEC 5.1). */
export type EvidenceActorKind = 'human' | 'group' | 'service'

/** `{kind, id, display?}` - the hitl-spec `decidedBy` shape (SPEC 4.1/4.2). */
export interface EvidenceActor {
  kind: EvidenceActorKind
  id: string
  display?: string
}

/**
 * How the reviewer reached HITLy. Device/channel details live ONLY here, in
 * `hitly.evidence.v1` (our evidence format): SPEC 5.3 says device data appears
 * only where an evidence format explicitly defines it, so it never goes into a
 * `hitl/event/v0` object. No IP address is recorded (privacy; minimal device data).
 */
export interface EvidenceClient {
  channel: 'web' | 'mobile' | 'api'
  /** Mobile only, when known. */
  platform?: 'ios' | 'android'
  /** Mobile only, when sent by the app. */
  appVersion?: string
  /** Raw UA, truncated to 512 chars, control chars stripped. */
  userAgent?: string
}

/**
 * `presented` payload (SPEC 5.2): recorded once, when the request is FIRST shown
 * to a reviewer who can decide. Sets `activity.presentedAt` (SPEC 4.3).
 * Like `decided`, it is host-sourced and carries no `data`.
 */
export interface EvidencePresented {
  presented_at: string
  actor: EvidenceActor
  source: 'host'
  client?: EvidenceClient
}

export interface EvidenceOversight {
  reviewer_id?: string
  decision?: Decision
  decided_at?: string
  response?: string
  edit_reason?: string
  edit_reason_text?: string
  /** Who decided, in the hitl-spec `decidedBy` shape (SPEC 4.1). Additive; `reviewer_id` stays. */
  decidedBy?: EvidenceActor
  /** Which device/channel the decision was made from. Additive. */
  client?: EvidenceClient
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
  /** Present on `presented` events only (SPEC 5.2): first shown to a reviewer. */
  presented?: EvidencePresented
  retention: EvidenceRetention
  integrity: EvidenceIntegrity

  toolName?: string
  sensitivity?: string[]
  dataCategories?: string[]
  externalUrls?: Array<{ url: string; label?: string }>
}

export interface AppendReceipt {
  event_id: string
  content_sha256: string
  store_uri: string
  stored_at: string
}

export interface EvidenceSink {
  id: 'none' | 'http' | 's3'
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
