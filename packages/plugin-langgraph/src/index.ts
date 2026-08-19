import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'
import { signHitlyResume } from './resume-auth'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((item) => optionalString(item)).filter((item): item is string => Boolean(item))
  return out.length > 0 ? out : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

interface LangGraphResumeHandle {
  deploymentUrl: string
  threadId: string
  assistantId?: string
  graphId?: string
}

interface HumanResponse {
  type: 'accept' | 'edit' | 'response' | 'ignore'
  args?: Record<string, unknown>
}

function decisionToHumanResponse(payload: DecisionPayload): HumanResponse {
  if (payload.decision === 'accept') {
    return { type: 'accept' }
  }
  if (payload.decision === 'edit') {
    return { type: 'edit', args: payload.editedArgs }
  }
  if (payload.decision === 'respond') {
    return { type: 'response', args: payload.response as any }
  }
  return { type: 'ignore' }
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

async function postLangGraphResume(
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
      error: `LangGraph resume failed (${response.status}): ${snippet}`,
    }
  }
  return { status: response.status, body: parsed }
}

/**
 * LangGraph pause: interrupt(HumanInterrupt).
 * Resume: Command({ resume: HumanResponse }).
 */
export const langgraphPlugin: HitlyPlugin = {
  id: 'langgraph',
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
    const body = asRecord(raw)
    const actionRequest = asRecord(body.action_request ?? body.action)
    const config = asRecord(body.config)
    const threadId = String(body.threadId ?? '')
    const projectId = String(body.projectId ?? '')
    const deploymentUrl = String(body.deploymentUrl ?? '')
    const graphId = optionalString(body.graphId)
    const assistantId = optionalString(body.assistantId)

    // Require threadId (do not accept missing to green tests)
    if (!threadId) {
      throw new Error('LangGraph ingest requires threadId')
    }

    const traceId = optionalString(body.traceId)
    const spanId = optionalString(body.spanId)
    const systemId = optionalString(body.systemId)
    const inventoryId = optionalString(body.inventoryId)
    const policyId = optionalString(body.policyId)
    const policyRationale = optionalString(body.policyRationale)
    const riskTier = optionalString(body.riskTier)
    const toolName = optionalString(body.toolName)
    const sensitivity = stringList(body.sensitivity)
    const dataCategories = stringList(body.dataCategories)

    return {
      action: {
        name: String(actionRequest.action ?? actionRequest.name ?? 'interrupt'),
        args: asRecord(actionRequest.args),
      },
      allowedActions: allowedActionsFor({
        accept: Boolean(config.allow_accept ?? true),
        reject: Boolean(config.allow_ignore ?? false),
        edit: Boolean(config.allow_edit ?? false),
        respond: Boolean(config.allow_respond ?? false),
        ignore: Boolean(config.allow_ignore ?? false),
      }),
      contextMarkdown: optionalString(body.description),
      traceId,
      spanId,
      systemId,
      inventoryId,
      policyId,
      policyRationale,
      riskTier,
      toolName,
      sensitivity,
      dataCategories,
      origin: {
        plugin: 'langgraph',
        projectId,
        runId: threadId,
        resumeHandle: {
          deploymentUrl,
          threadId,
          assistantId,
          graphId,
        },
        details: Object.fromEntries(
          Object.entries({
            threadId: threadId || undefined,
            graphId,
            assistantId,
            projectId: optionalString(body.projectId),
          }).filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
        traceId,
        spanId,
        systemId,
        inventoryId,
        policyId,
        policyRationale,
        riskTier,
        toolName,
      },
    }
  },
  async resume(
    origin: OriginRef,
    payload: DecisionPayload,
    credentials?: ConnectionCredentials,
  ): Promise<ResumeResponse> {
    const handle = origin.resumeHandle as unknown as LangGraphResumeHandle
    const deploymentUrl = handle.deploymentUrl
    const threadId = handle.threadId

    if (!deploymentUrl || !threadId) {
      return {
        resumeData: {},
        status: 0,
        body: null,
        error: 'LangGraph resume requires deploymentUrl and threadId',
      }
    }

    let humanResponse = decisionToHumanResponse(payload)
    const secret = typeof credentials?.resumeSecret === 'string' ? credentials.resumeSecret : ''
    const stepId = origin.stepId ?? ''
    const approvalId = typeof origin.resumeHandle.approvalId === 'string' ? origin.resumeHandle.approvalId : undefined

    // Sign the resume data with HITLy proof
    let resumeData = humanResponse as unknown as Record<string, unknown>
    if (secret) {
      resumeData = signHitlyResume({
        secret,
        resumeData,
        runId: threadId,
        stepId,
        approvalId,
      })
    }

    const assistantId = handle.assistantId || handle.graphId

    const token = typeof credentials?.token === 'string' ? credentials.token : ''
    const headers = token ? { authorization: `Bearer ${token}` } : undefined
    const root = deploymentUrl.replace(/\/$/, '')

    const resumeBody = {
      assistant_id: assistantId,
      command: { resume: resumeData },
    }

    const originResponse = await postLangGraphResume(
      `${root}/threads/${encodeURIComponent(threadId)}/runs/wait`,
      resumeBody,
      headers,
    )

    return { resumeData, ...originResponse }
  },
  async healthcheck(credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    const baseUrl = String(credentials.baseUrl ?? credentials.deploymentUrl ?? '')
    if (!baseUrl) return 'error'
    try {
      const root = baseUrl.replace(/\/$/, '')
      let response = await fetch(`${root}/ok`)
      if (response.ok) return 'ok'
      response = await fetch(`${root}/info`)
      return response.ok ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  },
}

export { langgraphPlugin as default }
export { signHitlyResume, verifyHitlyResume } from './resume-auth'
