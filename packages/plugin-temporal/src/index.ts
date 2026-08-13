import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
} from '@hitly/core'

export const HITLY_TEMPORAL_SIGNAL = 'hitly.decision'

/**
 * Temporal pause: activity creates the approval, then condition() until a signal.
 * Resume: Signal `hitly.decision` with { decision, args }. Stub until the SDK ships.
 */
export const temporalPlugin: HitlyPlugin = {
  id: 'temporal',
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
    const body = (raw ?? {}) as Record<string, unknown>
    return {
      action: {
        name: String(body.actionName ?? 'temporal-approval'),
        args: (body.args as Record<string, unknown>) ?? {},
      },
      allowedActions: allowedActionsFor({ accept: true, reject: true }),
      contextMarkdown: typeof body.contextMarkdown === 'string' ? body.contextMarkdown : undefined,
      origin: {
        plugin: 'temporal',
        connectionId: String(body.connectionId ?? ''),
        runId: String(body.workflowId ?? body.runId ?? ''),
        resumeHandle: {
          address: String(body.address ?? ''),
          namespace: String(body.namespace ?? 'default'),
          workflowId: String(body.workflowId ?? ''),
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      },
    }
  },
  async resume(_origin: OriginRef, _payload: DecisionPayload): Promise<void> {
    throw new Error('Temporal resume adapter is not implemented yet')
  },
  async healthcheck(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    return 'ok'
  },
}

export default temporalPlugin
