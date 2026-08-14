import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'

/**
 * n8n pause: Wait node On Webhook Call (`$execution.resumeUrl`).
 * Resume: POST the signed resume URL. Custom n8n node is not in v1.
 */
export const n8nPlugin: HitlyPlugin = {
  id: 'n8n',
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
    const body = (raw ?? {}) as Record<string, unknown>
    const resumeUrl = String(body.resumeUrl ?? '')
    if (!resumeUrl) throw new Error('n8n ingest requires resumeUrl ($execution.resumeUrl)')
    return {
      action: {
        name: String(body.actionName ?? 'n8n-wait'),
        args: (body.args as Record<string, unknown>) ?? {},
      },
      allowedActions: allowedActionsFor({ accept: true, reject: true }),
      contextMarkdown: typeof body.contextMarkdown === 'string' ? body.contextMarkdown : undefined,
      origin: {
        plugin: 'n8n',
        projectId: String(body.projectId ?? ''),
        runId: String(body.executionId ?? body.runId ?? ''),
        resumeHandle: { resumeUrl },
        details: Object.fromEntries(
          Object.entries({
            executionId: String(body.executionId ?? body.runId ?? '') || undefined,
            workflowId: typeof body.workflowId === 'string' ? body.workflowId : undefined,
            workflowName: typeof body.workflowName === 'string' ? body.workflowName : undefined,
          }).filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
      },
    }
  },
  async resume(origin: OriginRef, payload: DecisionPayload, _credentials?: ConnectionCredentials): Promise<ResumeResponse> {
    const resumeUrl = String(origin.resumeHandle.resumeUrl ?? '')
    const resumeData = payload as unknown as Record<string, unknown>
    const response = await fetch(resumeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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
        error: `n8n resume failed (${response.status}): ${snippet}`,
      }
    }
    return { resumeData, status: response.status, body }
  },
  async healthcheck(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    return 'ok'
  },
}

export default n8nPlugin
