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
  resumeUrl?: string
  metadata?: Record<string, unknown>
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
  const resumeUrl = optionalString(body.resumeUrl)
  const metadata = asRecord(body.metadata)
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
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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
        ...(resumeUrl ? { resumeUrl, metadata } : {}),
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
  const resumeUrl = String(origin.resumeHandle.resumeUrl ?? '')
  if (!resumeUrl) {
    return {
      resumeData: {},
      status: 0,
      body: null,
      error: 'Hermes resume requires resumeUrl. Origin should wait on callback, not poll HITLy.',
    }
  }

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
      error: `Hermes resume failed (${response.status}): ${snippet}`,
    }
  }

  return { resumeData, status: response.status, body }
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
