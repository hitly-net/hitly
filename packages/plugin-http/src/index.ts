import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
    return {
      action: {
        name: String(body.actionName ?? 'http-callback'),
        args,
      },
      allowedActions: allowedActionsFor({ accept: true, reject: true }),
      contextMarkdown: typeof body.contextMarkdown === 'string' ? body.contextMarkdown : undefined,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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
    const response = await fetch(resumeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resumeData),
    })
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
      const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text
      return {
        resumeData,
        status: response.status,
        body,
        error: `HTTP resume failed (${response.status}): ${snippet}`,
      }
    }
    return { resumeData, status: response.status, body }
  },
  async healthcheck(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    return 'ok'
  },
}

export default httpPlugin
