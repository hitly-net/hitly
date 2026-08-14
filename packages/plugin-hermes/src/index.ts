import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'

export type HermesKind = 'command' | 'kanban'

export interface HermesIngestPayload {
  plugin?: 'hermes'
  projectId: string
  kind?: HermesKind
  runId?: string
  expiresAt?: string
  contextMarkdown?: string
  command?: string
  description?: string
  patternKey?: string
  sessionKey?: string
  surface?: string
  requestId?: string
  taskId?: string
  profileName?: string
  kanbanStatus?: 'blocked' | 'review'
  reason?: string
  blockKind?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function originDetails(entries: Record<string, string | undefined>): Record<string, string> | undefined {
  const out = Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
  return Object.keys(out).length > 0 ? out : undefined
}

function hermesKind(body: Record<string, unknown>): HermesKind {
  if (body.kind === 'kanban' || optionalString(body.taskId)) return 'kanban'
  return 'command'
}

export function ingestHermes(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
  const body = asRecord(raw)
  const kind = hermesKind(body)
  const projectId = String(body.projectId ?? '')
  const requestId = optionalString(body.requestId)
  const sessionKey = optionalString(body.sessionKey)
  const patternKey = optionalString(body.patternKey)
  const surface = optionalString(body.surface)
  const command = optionalString(body.command)
  const description = optionalString(body.description)
  const taskId = optionalString(body.taskId)
  const profileName = optionalString(body.profileName)
  const kanbanStatus = body.kanbanStatus === 'review' ? 'review' : 'blocked'
  const reason = optionalString(body.reason)
  const blockKind = optionalString(body.blockKind)
  const runId =
    optionalString(body.runId) ??
    requestId ??
    (taskId ? `${taskId}:${kanbanStatus}` : undefined) ??
    sessionKey ??
    ''

  if (kind === 'kanban' && !taskId) {
    throw new Error('Hermes kanban ingest requires taskId')
  }
  if (kind === 'command' && !runId) {
    throw new Error('Hermes command ingest requires runId, requestId, or sessionKey')
  }
  if (!runId) {
    throw new Error('Hermes ingest requires runId')
  }

  const actionName =
    kind === 'kanban' ? (kanbanStatus === 'review' ? 'kanban-review' : 'kanban-block') : (patternKey ?? 'hermes-approval')

  const contextMarkdown =
    optionalString(body.contextMarkdown) ??
    (kind === 'kanban'
      ? [reason, profileName ? `Profile: ${profileName}` : undefined, taskId ? `Task: ${taskId}` : undefined]
          .filter(Boolean)
          .join('\n\n')
      : [description, command ? `\`\`\`\n${command}\n\`\`\`` : undefined].filter(Boolean).join('\n\n'))

  return {
    action: {
      name: actionName,
      args:
        kind === 'kanban'
          ? {
              taskId,
              profileName,
              kanbanStatus,
              reason,
              blockKind,
            }
          : {
              command,
              description,
              patternKey,
              surface,
              sessionKey,
            },
    },
    allowedActions: allowedActionsFor({
      accept: true,
      reject: true,
      respond: kind === 'kanban',
    }),
    contextMarkdown: contextMarkdown || undefined,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
    origin: {
      plugin: 'hermes',
      projectId,
      runId,
      stepId: kind === 'kanban' ? taskId : (patternKey ?? requestId),
      resumeHandle: {
        kind,
        requestId,
        taskId,
        runId,
      },
      details: originDetails({
        kind,
        surface,
        sessionKey,
        patternKey,
        taskId,
        profileName,
        kanbanStatus: kind === 'kanban' ? kanbanStatus : undefined,
        blockKind,
        runId,
      }),
    },
  }
}

export async function resumeHermes(
  origin: OriginRef,
  payload: DecisionPayload,
  _credentials?: ConnectionCredentials,
): Promise<ResumeResponse> {
  return {
    resumeData: payload as unknown as Record<string, unknown>,
    status: 200,
    body: { ok: true, kind: origin.resumeHandle.kind ?? origin.details?.kind ?? 'command' },
  }
}

export async function healthcheckHermes(_credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
  return 'ok'
}

export const hermesPlugin: HitlyPlugin = {
  id: 'hermes',
  ingest: ingestHermes,
  resume: resumeHermes,
  healthcheck: healthcheckHermes,
}

export { hermesPlugin as default }
