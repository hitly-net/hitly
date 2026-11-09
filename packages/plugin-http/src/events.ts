import { randomBytes } from 'node:crypto'
import type { DecisionPayload } from '@hitly/core'
import { redactSecrets } from './secrets.ts'

/** Final-decision event (default; keeps n8n Wait working). */
export const EVENT_DECIDED = 'decided'
/** Opt-in lifecycle events beyond the final decision. */
export const LIFECYCLE_EVENTS = ['presented', 'opened', 'cancelled', 'expired'] as const
export type LifecycleEventType = (typeof LIFECYCLE_EVENTS)[number]
export type HttpCallbackEventType = typeof EVENT_DECIDED | LifecycleEventType | 'answered'

export function isLifecycleEventType(value: string): value is LifecycleEventType {
  return (LIFECYCLE_EVENTS as readonly string[]).includes(value)
}

/** Parse opt-in lifecycle list from ingest or project credentials. */
export function parseLifecycleEvents(value: unknown): LifecycleEventType[] {
  if (!Array.isArray(value)) return []
  const out: LifecycleEventType[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim().toLowerCase()
    if (isLifecycleEventType(trimmed) && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

export function readLifecycleEvents(resumeHandle: Record<string, unknown>): LifecycleEventType[] {
  return parseLifecycleEvents(resumeHandle.lifecycleEvents)
}

/** Event id: evt_ + 32 hex chars. */
export function newEventId(): string {
  return `evt_${randomBytes(16).toString('hex')}`
}

export interface HttpCallbackBody {
  event_id: string
  type: HttpCallbackEventType
  request_id?: string
  idempotency_key?: string
  state?: string
  occurred_at: string
  decision?: string
  id?: string
  metadata?: Record<string, unknown>
  editedArgs?: Record<string, unknown>
  response?: string
  reason?: string
  decisionDetail?: {
    outcome: string
    reason: string | null
    decidedBy?: string
    client?: string
    editedArgs?: Record<string, unknown>
  }
  argsHash?: string
  answer?: unknown
  hash?: string
}

export interface BuildDecidedBodyArgs {
  eventId: string
  origin: { runId?: string; resumeHandle: Record<string, unknown> }
  payload: DecisionPayload & {
    answer?: unknown
    argsHash?: string
    decidedBy?: string
    client?: string
  }
  approvalId?: string
  occurredAt?: string
  asAnswered?: boolean
}

/**
 * Build the POST JSON for a final decision (or ask_user answered).
 * Keeps top-level decision / id / metadata so n8n Wait $json.decision still works.
 */
export function buildDecidedBody(args: BuildDecidedBodyArgs): HttpCallbackBody {
  const handle = args.origin.resumeHandle
  const metadata = redactSecrets(
    handle.metadata !== null && typeof handle.metadata === 'object' && !Array.isArray(handle.metadata)
      ? (handle.metadata as Record<string, unknown>)
      : {},
  )
  const occurred_at = args.occurredAt ?? new Date().toISOString()
  const approvalId =
    args.approvalId ??
    (typeof handle.approvalId === 'string' ? handle.approvalId : undefined)
  const type: HttpCallbackEventType = args.asAnswered || args.payload.answer !== undefined ? 'answered' : EVENT_DECIDED

  const body: HttpCallbackBody = {
    event_id: args.eventId,
    type,
    request_id: approvalId,
    occurred_at,
    state: type === 'answered' ? 'answered' : 'decided',
    decision: args.payload.decision,
    metadata,
  }
  if (approvalId) body.id = approvalId
  if (args.payload.editedArgs) body.editedArgs = args.payload.editedArgs
  if (args.payload.response) body.response = args.payload.response
  if (args.payload.reason) body.reason = args.payload.reason
  if (args.payload.argsHash) body.argsHash = args.payload.argsHash
  if (args.payload.answer !== undefined) body.answer = args.payload.answer
  else body.answer = null

  body.decisionDetail = {
    outcome: args.payload.decision,
    reason: args.payload.reason ?? null,
    decidedBy: args.payload.decidedBy,
    client: args.payload.client,
    ...(args.payload.editedArgs ? { editedArgs: args.payload.editedArgs } : {}),
  }

  const idem =
    typeof handle.idempotencyKey === 'string'
      ? handle.idempotencyKey
      : typeof handle.idempotency_key === 'string'
        ? handle.idempotency_key
        : undefined
  if (idem) body.idempotency_key = idem

  return body
}

export interface BuildLifecycleBodyArgs {
  eventId: string
  type: LifecycleEventType
  approvalId?: string
  occurredAt?: string
  metadata?: Record<string, unknown>
  state?: string
}

export function buildLifecycleBody(args: BuildLifecycleBodyArgs): HttpCallbackBody {
  return {
    event_id: args.eventId,
    type: args.type,
    request_id: args.approvalId,
    id: args.approvalId,
    occurred_at: args.occurredAt ?? new Date().toISOString(),
    state: args.state ?? args.type,
    metadata: redactSecrets(args.metadata ?? {}),
    answer: null,
  }
}

/** Stable event id for a logical delivery: reuse stored id on retries. */
export function eventIdFor(handle: Record<string, unknown>, logicalKey: string): string {
  const bag = handle.deliveryEventIds
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    const existing = (bag as Record<string, unknown>)[logicalKey]
    if (typeof existing === 'string' && existing.trim()) return existing.trim()
  }
  return newEventId()
}
