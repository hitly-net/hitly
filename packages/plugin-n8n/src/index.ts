import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
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
        connectionId: String(body.connectionId ?? ''),
        runId: String(body.executionId ?? body.runId ?? ''),
        resumeHandle: { resumeUrl },
      },
    }
  },
  async resume(origin: OriginRef, payload: DecisionPayload): Promise<void> {
    const resumeUrl = String(origin.resumeHandle.resumeUrl ?? '')
    const response = await fetch(resumeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error(`n8n resume failed (${response.status}): ${await response.text()}`)
    }
  },
  async healthcheck(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    return 'ok'
  },
}

export default n8nPlugin
