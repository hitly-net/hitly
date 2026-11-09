import {
  allowedActionsFor,
  type ApprovalAttachment,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type ExternalLink,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'
import { deliverHttpCallback, resolveSigningSecret } from './deliver.ts'
import {
  buildDecidedBody,
  buildLifecycleBody,
  eventIdFor,
  isLifecycleEventType,
  parseLifecycleEvents,
  readLifecycleEvents,
  type LifecycleEventType,
} from './events.ts'
import { CB_AUTH_TOKEN_KEY, readCbAuthToken, redactSecrets } from './secrets.ts'

export {
  buildSignatureHeaders,
  HEADER_EVENT_ID,
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  signBody,
  TIMESTAMP_MAX_SKEW_SECONDS,
  verifyHttpSignature,
  webhookKeyId,
} from './sign.ts'
export {
  buildDecidedBody,
  buildLifecycleBody,
  EVENT_DECIDED,
  LIFECYCLE_EVENTS,
  newEventId,
  parseLifecycleEvents,
  type HttpCallbackEventType,
  type LifecycleEventType,
} from './events.ts'
export { deliverHttpCallback, DEFAULT_BACKOFF_MS, resolveSigningSecret } from './deliver.ts'
export { CB_AUTH_TOKEN_KEY, containsSecretValue, readCbAuthToken, redactSecrets, SECRET_HANDLE_KEYS } from './secrets.ts'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function externalLinkList(value: unknown): ExternalLink[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ExternalLink[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ url: item.trim() })
    } else if (item && typeof item === 'object') {
      const record = asRecord(item)
      const url = optionalString(record.url)
      if (url) {
        const label = optionalString(record.label)
        const ref = optionalString(record.ref)
        const link: ExternalLink = { url }
        if (label) link.label = label
        if (ref) link.ref = ref
        if (record.mustOpen === true) link.mustOpen = true
        out.push(link)
      }
    }
  }
  return out.length > 0 ? out : undefined
}

function attachmentList(value: unknown): ApprovalAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ApprovalAttachment[] = []
  for (const item of value) {
    const record = asRecord(item)
    const name = optionalString(record.name)
    if (!name) continue
    const file: ApprovalAttachment = { name }
    const url = optionalString(record.url)
    if (url) file.url = url
    const contentType = optionalString(record.contentType)
    if (contentType) file.contentType = contentType
    const ref = optionalString(record.ref)
    if (ref) file.ref = ref
    if (record.mustOpen === true) file.mustOpen = true
    out.push(file)
  }
  return out.length > 0 ? out : undefined
}

/**
 * reasonRequired (hitl-spec 3.6): answer values that need a reason. A malformed
 * value is refused rather than silently dropped (spec 7). An explicit [] stays []:
 * that opts out of the reason prompt (the binary default ["reject"] from
 * resolveReasonRequired only applies when the field is absent). Absent/null stay
 * undefined so the binary-shaped default still applies in @hitly/core.
 */
function reasonRequiredList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('reasonRequired must be an array of non-empty answer values')
  }
  const out: string[] = []
  for (const item of value) {
    const entry = (item as string).trim()
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

export type HttpDecisionPayload = DecisionPayload & {
  /** Typed ask_user answer; travels only in the callback / decision payload. */
  answer?: unknown
  argsHash?: string
  decidedBy?: string
  client?: string
}

/**
 * http plugin: caller supplies resumeUrl.
 * Resume POSTs decision JSON (+ optional Bearer / HMAC / lifecycle). Default remains a
 * single final-decision POST so n8n Wait ($execution.resumeUrl) keeps working.
 *
 * Optional ingest fields (M0h):
 * - cb_auth_token / cbAuthToken: stored on resumeHandle (tenant-encrypted with origin),
 *   sent as Authorization Bearer, never echoed in resumeData / metadata / logs.
 * - lifecycleEvents: opt-in list among presented|opened|cancelled|expired.
 *
 * The stored create-once request is never mutated; editedArgs travel only in the
 * decision/response payload.
 */
export const httpPlugin: HitlyPlugin = {
  id: 'http',
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
    const body = (raw ?? {}) as Record<string, unknown>
    const resumeUrl = String(body.resumeUrl ?? '')
    if (!resumeUrl) throw new Error('HTTP ingest requires resumeUrl')
    const executionId = optionalString(body.executionId)
    const runId = optionalString(body.runId) ?? executionId ?? ''
    if (!runId) throw new Error('HTTP ingest requires runId or executionId')
    const workflowId = optionalString(body.workflowId)
    const workflowName = optionalString(body.workflowName)
    const args = asRecord(body.args)
    const metadata = asRecord(body.metadata)
    const pageId = optionalString(metadata.pageId) ?? optionalString(args.pageId)

    const allowedActionsPartial =
      body.allowedActions && typeof body.allowedActions === 'object'
        ? (body.allowedActions as Record<string, boolean>)
        : undefined
    const editableFields =
      body.editableFields && typeof body.editableFields === 'object'
        ? (body.editableFields as Record<string, Record<string, unknown>>)
        : undefined
    const editReason =
      body.editReason && typeof body.editReason === 'object' ? (body.editReason as Record<string, unknown>) : undefined
    const reasonRequired = reasonRequiredList(body.reasonRequired)

    const cbAuthToken = optionalString(body.cb_auth_token) ?? optionalString(body.cbAuthToken)
    const lifecycleEvents = parseLifecycleEvents(body.lifecycleEvents ?? body.lifecycle_events)

    const resumeHandle: Record<string, unknown> = { resumeUrl, metadata }
    if (cbAuthToken) resumeHandle[CB_AUTH_TOKEN_KEY] = cbAuthToken
    if (lifecycleEvents.length > 0) resumeHandle.lifecycleEvents = lifecycleEvents
    const idempotencyKey = optionalString(body.idempotencyKey) ?? optionalString(body.idempotency_key)
    if (idempotencyKey) resumeHandle.idempotencyKey = idempotencyKey

    return {
      action: {
        name: String(body.actionName ?? 'http-callback'),
        args,
      },
      allowedActions: allowedActionsFor(allowedActionsPartial ?? { accept: true, reject: true }),
      contextMarkdown: typeof body.contextMarkdown === 'string' ? body.contextMarkdown : undefined,
      externalUrls: externalLinkList(body.externalUrls),
      attachments: attachmentList(body.attachments),
      ...(reasonRequired ? { reasonRequired } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      editableFields: editableFields as any,
      editReason: editReason as any,
      origin: {
        plugin: 'http',
        projectId: String(body.projectId ?? ''),
        runId,
        resumeHandle,
        details: Object.fromEntries(
          Object.entries({
            executionId,
            workflowId,
            workflowName,
            pageId,
          }).filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
      },
    }
  },
  async resume(
    origin: OriginRef,
    payload: DecisionPayload,
    credentials?: ConnectionCredentials,
  ): Promise<ResumeResponse> {
    const resumeUrl = String(origin.resumeHandle.resumeUrl ?? '')
    const handle = origin.resumeHandle
    const approvalId = optionalString(handle.approvalId)
    const eventId = eventIdFor(handle, 'decided')
    const body = buildDecidedBody({
      eventId,
      origin,
      payload: payload as HttpDecisionPayload,
      approvalId,
    })
    const rawBody = JSON.stringify(body)
    const result = await deliverHttpCallback({
      resumeUrl,
      rawBody,
      eventId,
      cbAuthToken: readCbAuthToken(handle),
      signingSecret: resolveSigningSecret(credentials as Record<string, unknown> | undefined),
    })
    result.response.resumeData = redactSecrets(result.response.resumeData)
    return result.response
  },
  async healthcheck(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    return 'ok'
  },
}

/**
 * Deliver an opt-in lifecycle callback (presented|opened|cancelled|expired).
 * No-ops when the request did not opt in. Reuses destination checks + auth/HMAC/retries.
 */
export async function deliverHttpLifecycleEvent(args: {
  origin: OriginRef
  type: LifecycleEventType | string
  credentials?: ConnectionCredentials
  approvalId?: string
  occurredAt?: string
  state?: string
}): Promise<ResumeResponse | null> {
  if (!isLifecycleEventType(args.type)) return null
  const enabled = readLifecycleEvents(args.origin.resumeHandle)
  if (!enabled.includes(args.type)) return null

  const resumeUrl = String(args.origin.resumeHandle.resumeUrl ?? '')
  if (!resumeUrl) return null
  const approvalId = args.approvalId ?? optionalString(args.origin.resumeHandle.approvalId)
  const eventId = eventIdFor(args.origin.resumeHandle, args.type)
  const metadata = asRecord(args.origin.resumeHandle.metadata)
  const body = buildLifecycleBody({
    eventId,
    type: args.type,
    approvalId,
    occurredAt: args.occurredAt,
    metadata,
    state: args.state,
  })
  const rawBody = JSON.stringify(body)
  const result = await deliverHttpCallback({
    resumeUrl,
    rawBody,
    eventId,
    cbAuthToken: readCbAuthToken(args.origin.resumeHandle),
    signingSecret: resolveSigningSecret(args.credentials as Record<string, unknown> | undefined),
  })
  result.response.resumeData = redactSecrets(result.response.resumeData)
  return result.response
}

export default httpPlugin
