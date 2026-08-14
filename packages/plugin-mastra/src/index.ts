import {
  allowedActionsFor,
  type ApprovalAttachment,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'
import { signHitlyResume } from './resume-auth'

export type MastraResumeKind = 'workflow' | 'agent'

export interface MastraIngestPayload {
  plugin?: 'mastra'
  projectId: string
  runId: string
  kind?: MastraResumeKind
  workflowId?: string
  workflowName?: string
  agentId?: string
  agentName?: string
  stepId?: string
  stepName?: string
  toolCallId?: string
  resourceId?: string
  threadId?: string
  action?: { name: string; args?: Record<string, unknown> }
  suspendPayload?: { reason?: string; [key: string]: unknown }
  resumeSchema?: Record<string, unknown>
  expiresAt?: string
  mastraBaseUrl?: string
}

export interface MastraWorkflowResumeHandle {
  mastraBaseUrl: string
  kind?: 'workflow'
  workflowId: string
  runId: string
  stepId: string
}

export interface MastraAgentResumeHandle {
  mastraBaseUrl: string
  kind: 'agent'
  agentId: string
  runId: string
  toolCallId?: string
}

export type MastraResumeHandle = MastraWorkflowResumeHandle | MastraAgentResumeHandle

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((item) => optionalString(item)).filter((item): item is string => Boolean(item))
  return out.length > 0 ? out : undefined
}

function attachmentList(value: unknown): ApprovalAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ApprovalAttachment[] = []
  for (const item of value) {
    const record = asRecord(item)
    const name = optionalString(record.name)
    if (!name) continue
    out.push({
      name,
      url: optionalString(record.url),
      contentType: optionalString(record.contentType),
    })
  }
  return out.length > 0 ? out : undefined
}

function originDetails(entries: Record<string, string | undefined>): Record<string, string> | undefined {
  const out = Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
  return Object.keys(out).length > 0 ? out : undefined
}

function resumeKind(handle: MastraResumeHandle): MastraResumeKind {
  if (handle.kind === 'agent' || 'agentId' in handle) return 'agent'
  return 'workflow'
}

function decisionResumeData(payload: DecisionPayload): Record<string, unknown> {
  if (payload.decision === 'edit') return { approved: true, ...payload.editedArgs }
  if (payload.decision === 'respond') return { approved: true, response: payload.response }
  return { approved: payload.decision === 'accept' }
}

const MAX_RESUME_BODY = 64_000

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return undefined
}

/** Mastra can return HTTP 200 with `{ status: "failed", error }` after resume. */
function mastraRunError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (record.status !== 'failed' && record.status !== 'error') return undefined
  return errorMessage(record.error) ?? 'Origin reported the resume as failed'
}

async function postMastraResume(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; error?: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let parsed: unknown = text || null
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      parsed = text.length > MAX_RESUME_BODY ? `${text.slice(0, MAX_RESUME_BODY)}…` : text
    }
  }
  if (!response.ok) {
    const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text
    return {
      status: response.status,
      body: parsed,
      error: `Mastra resume failed (${response.status}): ${snippet}`,
    }
  }
  const error = mastraRunError(parsed)
  return error ? { status: response.status, body: parsed, error } : { status: response.status, body: parsed }
}

export function ingestMastra(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
  const body = asRecord(raw)
  const action = asRecord(body.action)
  const suspendPayload = asRecord(body.suspendPayload)
  const mastraBaseUrl = String(body.mastraBaseUrl ?? '')
  const workflowId = String(body.workflowId ?? '')
  const agentId = String(body.agentId ?? '')
  const runId = String(body.runId ?? '')
  const stepId = String(body.stepId ?? body.toolCallId ?? 'approval')
  const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : undefined
  const projectId = String(body.projectId ?? '')
  const agentName = optionalString(body.agentName)
  const workflowName = optionalString(body.workflowName)
  const stepName = optionalString(body.stepName)
  const kind: MastraResumeKind =
    body.kind === 'agent' || (!workflowId && Boolean(agentId)) ? 'agent' : 'workflow'

  if (!runId) {
    throw new Error('Mastra ingest requires runId')
  }
  if (kind === 'agent' && !agentId) {
    throw new Error('Mastra agent ingest requires agentId')
  }
  if (kind === 'workflow' && !workflowId) {
    throw new Error('Mastra workflow ingest requires workflowId')
  }

  const resumeHandle: MastraResumeHandle =
    kind === 'agent'
      ? {
          mastraBaseUrl,
          kind: 'agent',
          agentId,
          runId,
          toolCallId: toolCallId ?? (stepId || undefined),
        }
      : {
          mastraBaseUrl,
          kind: 'workflow',
          workflowId,
          runId,
          stepId,
        }

  return {
    action: {
      name: String(action.name ?? stepId),
      args: asRecord(action.args ?? suspendPayload),
    },
    allowedActions: allowedActionsFor({
      accept: true,
      reject: true,
      edit: Boolean(body.resumeSchema),
    }),
    contextMarkdown:
      optionalString(suspendPayload.contextMarkdown) ??
      optionalString(body.contextMarkdown) ??
      optionalString(suspendPayload.reason),
    externalUrls: stringList(suspendPayload.externalUrls) ?? stringList(body.externalUrls),
    attachments: attachmentList(suspendPayload.attachments) ?? attachmentList(body.attachments),
    resumeSchema: asRecord(body.resumeSchema),
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
    origin: {
      plugin: 'mastra',
      projectId,
      runId,
      stepId,
      resumeHandle: resumeHandle as unknown as Record<string, unknown>,
      details: originDetails({
        kind,
        agentId: kind === 'agent' ? agentId : undefined,
        agentName,
        workflowId: kind === 'workflow' ? workflowId : undefined,
        workflowName,
        stepId,
        stepName: stepName ?? (kind === 'agent' ? optionalString(action.name) : undefined),
        toolCallId,
        runId,
        resourceId: optionalString(body.resourceId),
        threadId: optionalString(body.threadId),
      }),
    },
  }
}

export async function resumeMastra(
  origin: OriginRef,
  payload: DecisionPayload,
  credentials?: ConnectionCredentials,
): Promise<ResumeResponse> {
  const handle = origin.resumeHandle as unknown as MastraResumeHandle
  const baseUrl = handle.mastraBaseUrl
  if (!baseUrl) {
    throw new Error('Mastra resume requires mastraBaseUrl on the origin handle')
  }

  const secret = typeof credentials?.resumeSecret === 'string' ? credentials.resumeSecret : ''
  const token = typeof credentials?.token === 'string' ? credentials.token : ''
  const stepId = 'stepId' in handle ? String(handle.stepId ?? '') : String(handle.toolCallId ?? origin.stepId ?? '')
  let resumeData = decisionResumeData(payload)
  if (secret) {
    resumeData = signHitlyResume({
      secret,
      resumeData,
      runId: handle.runId || origin.runId,
      stepId,
      approvalId: typeof origin.resumeHandle.approvalId === 'string' ? origin.resumeHandle.approvalId : undefined,
    })
  }
  const headers = token ? { authorization: `Bearer ${token}` } : undefined
  const root = baseUrl.replace(/\/$/, '')
  const kind = resumeKind(handle)

  if (kind === 'agent') {
    const agentHandle = handle as MastraAgentResumeHandle
    if (!agentHandle.agentId) {
      throw new Error('Mastra agent resume requires agentId')
    }
    const originResponse = await postMastraResume(
      `${root}/api/agents/${encodeURIComponent(agentHandle.agentId)}/resume-stream`,
      {
        runId: agentHandle.runId,
        toolCallId: agentHandle.toolCallId,
        resumeData,
      },
      headers,
    )
    return { resumeData, ...originResponse }
  }

  const workflowHandle = handle as MastraWorkflowResumeHandle
  if (!workflowHandle.workflowId) {
    throw new Error('Mastra workflow resume requires workflowId')
  }
  const originResponse = await postMastraResume(
    `${root}/api/workflows/${encodeURIComponent(workflowHandle.workflowId)}/resume-async?runId=${encodeURIComponent(workflowHandle.runId)}`,
    {
      runId: workflowHandle.runId,
      step: workflowHandle.stepId,
      resumeData,
    },
    headers,
  )
  return { resumeData, ...originResponse }
}

export async function healthcheckMastra(credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
  const baseUrl = String(credentials.baseUrl ?? '')
  if (!baseUrl) return 'error'
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/agents`)
    return response.ok ? 'ok' : 'error'
  } catch {
    return 'error'
  }
}

export const mastraPlugin: HitlyPlugin = {
  id: 'mastra',
  ingest: ingestMastra,
  resume: resumeMastra,
  healthcheck: healthcheckMastra,
}

export interface HitlyApprovalStepConfig {
  apiUrl: string
  apiKey: string
  projectId: string
  mastraBaseUrl?: string
  action: { name: string; args?: Record<string, unknown> }
  kind?: MastraResumeKind
  workflowId?: string
  workflowName?: string
  agentId?: string
  agentName?: string
  stepId?: string
  stepName?: string
  toolCallId?: string
  resourceId?: string
  threadId?: string
}

/**
 * Payload posted to Hitly when a Mastra workflow step or agent tool suspends.
 * Wire this from `createStep({ execute })` or `createTool({ execute })`.
 */
export async function notifyHitlyApproval(
  config: HitlyApprovalStepConfig,
  input: { runId: string; suspendPayload?: Record<string, unknown>; resumeSchema?: Record<string, unknown> },
): Promise<void> {
  const kind: MastraResumeKind = config.kind ?? (config.agentId ? 'agent' : 'workflow')
  if (kind === 'agent' && !config.agentId) {
    throw new Error('Hitly Mastra notify requires agentId for agent approvals')
  }
  if (kind === 'workflow' && !config.workflowId) {
    throw new Error('Hitly Mastra notify requires workflowId for workflow approvals')
  }

  const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/api/v1/approvals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      plugin: 'mastra',
      projectId: config.projectId,
      mastraBaseUrl: config.mastraBaseUrl,
      kind,
      workflowId: config.workflowId,
      workflowName: config.workflowName,
      agentId: config.agentId,
      agentName: config.agentName,
      runId: input.runId,
      stepId: config.stepId ?? config.toolCallId ?? 'hitly-approval',
      stepName: config.stepName,
      toolCallId: config.toolCallId,
      resourceId: config.resourceId,
      threadId: config.threadId,
      action: config.action,
      suspendPayload: input.suspendPayload,
      resumeSchema: input.resumeSchema,
    } satisfies MastraIngestPayload),
  })

  if (!response.ok) {
    throw new Error(`Hitly ingest failed (${response.status}): ${await response.text()}`)
  }
}

export { mastraPlugin as default }
export { signHitlyResume, verifyHitlyResume } from './resume-auth'
