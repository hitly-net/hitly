import { timingSafeEqual } from 'node:crypto'
import { verifyHttpSignature, HEADER_EVENT_ID, HEADER_KEY_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP } from '@hitly/plugin-http'
import type { PluginRuntimeConfig } from './types.ts'

export interface SeenEventStore {
  check(eventId: string): boolean
  remember(eventId: string): void
}

export interface ApprovalAuthorityState {
  id: string
  status: string
  decision: string | null
  metadata: Record<string, unknown>
  /** Decision payload, present once HITLy holds a decision. */
  reason?: string
  editedArgs?: Record<string, unknown>
  response?: string
  answer?: string
}

export interface ResumeDispatch {
  approvalId: string
  decision: string
  gate: string
  reason?: string
  editedArgs?: Record<string, unknown>
  response?: string
  metadata: Record<string, unknown>
}

export interface ResumeDeps {
  dedupe: SeenEventStore
  /** Expected callback bearer for this approval (the cbAuthToken sent at create). Undefined → reject. */
  bearerFor(approvalId: string): string | undefined
  fetchApprovalState(approvalId: string): Promise<ApprovalAuthorityState>
  apply(cmd: ResumeDispatch): Promise<{ applied: boolean; reason?: string }>
  log?(level: string, message: string, meta?: Record<string, unknown>): void
}

/** Callback event types that carry a human decision. Everything else is lifecycle. */
const DECISION_TYPES = new Set(['decided', 'answered'])

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function bearerOf(headers: Headers): string {
  const header = headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function bearerEquals(value: string, expected: string | undefined): boolean {
  if (!value || !expected) return false
  const a = Buffer.from(value, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * HITLy decided/answered callback receiver.
 *
 * Auth order (all failures are 401, nothing dispatched):
 *  1. Bearer token present — rejects anonymous probes before any parsing.
 *  2. Bearer equals the per-approval cbAuthToken sent at create time
 *     (resolved from the body's approval id; unknown approvals reject).
 *  3. HMAC-SHA256 signature over `timestamp.rawBody`, 5-min skew window,
 *     verifying against every configured project webhook signing secret
 *     (rotation = overlap window).
 *  4. Event-id dedupe — duplicates are ACKED with 200 (stops HITLy retries)
 *     but never re-dispatched.
 *  5. HITLy is the AUTHORITY: the callback's claim is re-checked against
 *     GET /api/v1/approvals/:id. pending/expired/cancelled/failed_resume
 *     never dispatch — a callback can never upgrade state into approval.
 */
export async function handleResumeRequest(args: {
  headers: Headers
  rawBody: string
  config: PluginRuntimeConfig
  deps: ResumeDeps
}, nowSeconds?: number): Promise<Response> {
  const { headers, rawBody, config, deps } = args

  // Cheap anti-probe gate: no bearer at all → 401 before touching the body.
  if (!bearerOf(headers)) {
    deps.log?.('warn', 'hitly resume: bearer rejected')
    return json(401, { error: 'unauthorized' })
  }

  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(rawBody) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return json(400, { error: 'invalid_json' })
  }

  const eventId = headers.get(HEADER_EVENT_ID)?.trim() || (typeof body.event_id === 'string' ? body.event_id : '')
  const type = typeof body.type === 'string' ? body.type : ''
  const approvalId = typeof body.id === 'string' ? body.id : ''
  if (!eventId || !type || !approvalId) {
    return json(400, { error: 'missing_event_fields' })
  }

  // Per-approval binding: HITLy echoes the cbAuthToken we generated at
  // create time. A bearer that is valid for another (or no) approval fails.
  if (!bearerEquals(bearerOf(headers), deps.bearerFor(approvalId))) {
    deps.log?.('warn', 'hitly resume: bearer rejected', { approvalId })
    return json(401, { error: 'unauthorized' })
  }

  const signatureVerified = config.webhookSigningSecrets.some((secret) => {
    const result = verifyHttpSignature({
      secret,
      rawBody,
      timestampHeader: headers.get(HEADER_TIMESTAMP),
      signatureHeader: headers.get(HEADER_SIGNATURE),
      keyIdHeader: headers.get(HEADER_KEY_ID),
      nowSeconds: nowSeconds,
    })
    // A key-id the plugin doesn't know about is NOT a rejection when the
    // HMAC itself matches one of the configured secrets: rotation may rename
    // keys while env secrets stay valid within the overlap window.
    return result.ok || (!result.ok && result.reason === 'key_mismatch' && replayVerifyWithoutKeyId(secret))
  })

  function replayVerifyWithoutKeyId(secret: string): boolean {
    const result = verifyHttpSignature({
      secret,
      rawBody,
      timestampHeader: headers.get(HEADER_TIMESTAMP),
      signatureHeader: headers.get(HEADER_SIGNATURE),
      keyIdHeader: null,
      nowSeconds: nowSeconds,
    })
    return result.ok
  }

  if (!signatureVerified) {
    deps.log?.('warn', 'hitly resume: signature rejected', { eventId })
    return json(401, { error: 'invalid_signature' })
  }

  if (!DECISION_TYPES.has(type)) {
    // Lifecycle (opened/expired/cancelled/...): acknowledge; the
    // reconciliation worker owns closure actions from authoritative state.
    deps.dedupe.remember(eventId)
    return json(200, { ok: true, ack: type })
  }

  if (deps.dedupe.check(eventId)) {
    return json(200, { ok: true, duplicate: true })
  }

  let authority: ApprovalAuthorityState
  try {
    authority = await deps.fetchApprovalState(approvalId)
  } catch (error) {
    const status = (error as { status?: number }).status
    deps.log?.('error', 'hitly resume: authority read failed', { approvalId, status })
    // 502 so HITLy retries; the poller is the backstop if retries run out.
    return json(status === 404 ? 404 : 502, { error: 'authority_unavailable' })
  }

  if (authority.status !== 'decided' || !authority.decision) {
    // The callback claimed a decision HITLy does not have. Expiry, pending,
    // and cancellation are never approval.
    deps.log?.('warn', 'hitly resume: callback claim contradicted by authority', {
      approvalId,
      claimed: type,
      actual: authority.status,
    })
    deps.dedupe.remember(eventId)
    return json(200, { ok: true, ignored: authority.status })
  }

  const metadata = { ...(typeof body.metadata === 'object' && body.metadata !== null ? (body.metadata as Record<string, unknown>) : {}), ...authority.metadata }
  const gate = typeof metadata['net.hitly/gate'] === 'string' ? (metadata['net.hitly/gate'] as string) : ''
  if (!gate) {
    deps.log?.('warn', 'hitly resume: approval missing gate metadata', { approvalId })
    return json(200, { ok: true, ignored: 'missing_gate_metadata' })
  }

  const cmd: ResumeDispatch = {
    approvalId,
    decision: authority.decision,
    gate,
    metadata,
  }
  if (typeof body.reason === 'string') cmd.reason = body.reason
  if (typeof body.editedArgs === 'object' && body.editedArgs !== null) cmd.editedArgs = body.editedArgs as Record<string, unknown>
  const responseValue = typeof body.response === 'string' ? body.response : typeof body.answer === 'string' ? body.answer : undefined
  if (responseValue) cmd.response = responseValue

  const outcome = await deps.apply(cmd)
  deps.dedupe.remember(eventId)
  deps.log?.('info', 'hitly resume: decision applied', { approvalId, gate, decision: authority.decision, applied: outcome.applied })
  return json(200, { ok: true, applied: outcome.applied, reason: outcome.reason })
}
