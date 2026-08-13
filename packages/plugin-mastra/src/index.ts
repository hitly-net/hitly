import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
} from '@hitly/core'

export interface MastraIngestPayload {
  plugin?: 'mastra'
  connectionId: string
  runId: string
  workflowId: string
  stepId: string
  action?: { name: string; args?: Record<string, unknown> }
  suspendPayload?: { reason?: string; [key: string]: unknown }
  resumeSchema?: Record<string, unknown>
  expiresAt?: string
  mastraBaseUrl: string
}

export interface MastraResumeHandle {
  mastraBaseUrl: string
  workflowId: string
  runId: string
  stepId: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function ingestMastra(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
  const body = asRecord(raw)
  const action = asRecord(body.action)
  const suspendPayload = asRecord(body.suspendPayload)
  const mastraBaseUrl = String(body.mastraBaseUrl ?? '')
  const workflowId = String(body.workflowId ?? '')
  const runId = String(body.runId ?? '')
  const stepId = String(body.stepId ?? 'approval')
  const connectionId = String(body.connectionId ?? '')

  if (!mastraBaseUrl || !workflowId || !runId) {
    throw new Error('Mastra ingest requires mastraBaseUrl, workflowId, and runId')
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
      typeof suspendPayload.reason === 'string' ? suspendPayload.reason : undefined,
    resumeSchema: asRecord(body.resumeSchema),
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
    origin: {
      plugin: 'mastra',
      connectionId,
      runId,
      stepId,
      resumeHandle: {
        mastraBaseUrl,
        workflowId,
        runId,
        stepId,
      } satisfies MastraResumeHandle,
    },
  }
}

export async function resumeMastra(origin: OriginRef, payload: DecisionPayload): Promise<void> {
  const handle = origin.resumeHandle as unknown as MastraResumeHandle
  const approved = payload.decision === 'accept' || payload.decision === 'edit'
  const resumeData =
    payload.decision === 'edit'
      ? { approved: true, ...payload.editedArgs }
      : payload.decision === 'respond'
        ? { approved: true, response: payload.response }
        : { approved }

  const url = `${handle.mastraBaseUrl.replace(/\/$/, '')}/api/workflows/${encodeURIComponent(handle.workflowId)}/resume`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: handle.runId,
      step: handle.stepId,
      resumeData,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Mastra resume failed (${response.status}): ${text}`)
  }
}

export async function healthcheckMastra(credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
  const baseUrl = String(credentials.baseUrl ?? '')
  if (!baseUrl) return 'error'
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`)
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
  connectionId: string
  mastraBaseUrl: string
  action: { name: string; args?: Record<string, unknown> }
  workflowId: string
  stepId?: string
}

/**
 * Payload posted to Hitly when a Mastra step suspends.
 * Wire this from `createStep({ execute })` until `@mastra/core` is a hard dependency.
 */
export async function notifyHitlyApproval(
  config: HitlyApprovalStepConfig,
  input: { runId: string; suspendPayload?: Record<string, unknown>; resumeSchema?: Record<string, unknown> },
): Promise<void> {
  const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/api/v1/approvals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      plugin: 'mastra',
      connectionId: config.connectionId,
      mastraBaseUrl: config.mastraBaseUrl,
      workflowId: config.workflowId,
      runId: input.runId,
      stepId: config.stepId ?? 'hitly-approval',
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
