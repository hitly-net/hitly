import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
} from '@hitly/core'

/**
 * LangGraph pause: interrupt(HumanInterrupt).
 * Resume: Command({ resume: HumanResponse }). Stub until the SDK ships.
 */
export const langgraphPlugin: HitlyPlugin = {
  id: 'langgraph',
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
    const body = (raw ?? {}) as Record<string, unknown>
    const actionRequest = (body.action_request ?? body.action ?? {}) as Record<string, unknown>
    const config = (body.config ?? {}) as Record<string, unknown>
    return {
      action: {
        name: String(actionRequest.action ?? actionRequest.name ?? 'interrupt'),
        args: (actionRequest.args as Record<string, unknown>) ?? {},
      },
      allowedActions: allowedActionsFor({
        accept: Boolean(config.allow_accept ?? true),
        reject: Boolean(config.allow_ignore ?? true),
        edit: Boolean(config.allow_edit ?? false),
        respond: Boolean(config.allow_respond ?? false),
        ignore: Boolean(config.allow_ignore ?? false),
      }),
      contextMarkdown: typeof body.description === 'string' ? body.description : undefined,
      origin: {
        plugin: 'langgraph',
        projectId: String(body.projectId ?? ''),
        runId: String(body.threadId ?? body.runId ?? ''),
        resumeHandle: {
          deploymentUrl: String(body.deploymentUrl ?? ''),
          threadId: String(body.threadId ?? ''),
        },
        details: Object.fromEntries(
          Object.entries({
            threadId: String(body.threadId ?? body.runId ?? '') || undefined,
            graphId: typeof body.graphId === 'string' ? body.graphId : undefined,
            assistantId: typeof body.assistantId === 'string' ? body.assistantId : undefined,
          }).filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
      },
    }
  },
  async resume(_origin: OriginRef, _payload: DecisionPayload, _credentials?: ConnectionCredentials): Promise<void> {
    throw new Error('LangGraph resume adapter is not implemented yet')
  },
  async healthcheck(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    return 'ok'
  },
}

export default langgraphPlugin
