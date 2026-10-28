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
import { checkedFetch, destinationHost, destinationStatusMessage } from '@hitly/core/destination-check'

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
 * `reasonRequired` (hitl-spec 3.6): answer values that need a reason. A malformed
 * value is refused rather than silently dropped (spec 7). An explicit `[]` stays `[]`:
 * that opts out of the reason prompt (the binary default `["reject"]` from
 * `resolveReasonRequired` only applies when the field is absent). Absent/null stay
 * `undefined` so the binary-shaped default still applies in @hitly/core.
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

/**
 * Generic HTTP pause: caller supplies `resumeUrl`.
 * Resume: POST the decision JSON plus ingest `metadata`. n8n Wait (`$execution.resumeUrl`) is one host of this callback.
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
        resumeHandle: { resumeUrl, metadata },
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
  async resume(origin: OriginRef, payload: DecisionPayload, _credentials?: ConnectionCredentials): Promise<ResumeResponse> {
    const resumeUrl = String(origin.resumeHandle.resumeUrl ?? '')
    const metadata = asRecord(origin.resumeHandle.metadata)
    const resumeData: Record<string, unknown> = {
      decision: payload.decision,
      metadata,
    }
    const approvalId = optionalString(origin.resumeHandle.approvalId)
    if (approvalId) resumeData.id = approvalId
    if (payload.editedArgs) resumeData.editedArgs = payload.editedArgs
    if (payload.response) resumeData.response = payload.response
    if (payload.reason) resumeData.reason = payload.reason
    const response = await checkedFetch(
      resumeUrl,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(resumeData) },
      { totalTimeoutMs: 60_000 },
    )
    const text = await response.text()
    let body: unknown = text || null
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = text
      }
    }
    if (!response.ok) {
        return {
        resumeData,
        status: response.status,
        body: null,
        error: destinationStatusMessage('HTTP resume', response.status, destinationHost(resumeUrl)),
      }
    }
    return { resumeData, status: response.status, body }
  },
  async healthcheck(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    return 'ok'
  },
}

export default httpPlugin
