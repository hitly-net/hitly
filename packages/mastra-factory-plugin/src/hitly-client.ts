import type { ApprovalRef, ApprovalRequest, Gate } from './types.ts'
import type { ApprovalAuthorityState } from './resume.ts'

export class HitlyApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'HitlyApiError'
    this.status = status
    this.code = code
  }
}

/** Thrown when an Idempotency-Key was already used with a different body (409). */
// eslint-disable-next-line @typescript-eslint/naming-convention
export class IDEMPOTENCY_CONFLICT extends HitlyApiError {
  constructor(message = 'idempotency key already used with a different body') {
    super(message, 409, 'idempotency_conflict')
    this.name = 'IdempotencyConflictError'
  }
}

export interface HitlyClientConfig {
  hitlyBaseUrl: string
  hitlyApiKey: string
  projectId: string
  fetchImpl?: typeof fetch
}

export interface RemoteIntegrationConfig {
  gates: Record<Gate, boolean>
  mergeAfterAccept: boolean
}

/**
 * Minimal HITLy REST client (project-scoped API key). Endpoints:
 * - POST /api/v1/approvals (create; Idempotency-Key create-once)
 * - GET  /api/v1/projects/:id/integrations/mastra-factory/approvals/:approvalId
 *      (authoritative approval state — the plugin trusts only this, never the
 *      callback's claim; carries the gate + session identity metadata)
 * - GET  /api/v1/projects/:id/integrations/mastra-factory/approvals
 *      (restart-seed feed: open gate approvals with create-time metadata)
 * - POST /api/v1/projects/:id/integrations/mastra-factory/approvals/:approvalId/resume-ack
 *      (host receipt: settle a converged failed_resume row to decided)
 * - GET  /api/v1/projects/:id/integrations/mastra-factory (gate config)
 *
 * The integration-namespace reads (not the generic requester list) are the
 * only contract that guarantees the `net.hitly/*` gate/session metadata the
 * reconciler needs to re-adopt approvals after a Factory restart.
 */
export class HitlyClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly projectId: string
  private readonly fetchImpl: typeof fetch

  constructor(config: HitlyClientConfig) {
    this.baseUrl = config.hitlyBaseUrl.replace(/\/+$/, '')
    this.apiKey = config.hitlyApiKey
    this.projectId = config.projectId
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  private async request(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  }

  private static errorFrom(status: number, body: unknown): HitlyApiError {
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const code = typeof record.error === 'string' ? record.error : `http_${status}`
    const message = typeof record.message === 'string' ? record.message : `HITLy API error ${status} (${code})`
    return new HitlyApiError(message, status, code)
  }

  async createApproval(body: ApprovalRequest | Record<string, unknown>, idempotencyKey: string): Promise<ApprovalRef> {
    const { status, body: parsed } = await this.request('/api/v1/approvals', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    })
    if (status === 409) {
      throw new IDEMPOTENCY_CONFLICT()
    }
    if (status !== 200 && status !== 201) {
      throw HitlyClient.errorFrom(status, parsed)
    }
    const record = (parsed ?? {}) as Record<string, unknown>
    if (typeof record.id !== 'string') {
      throw new HitlyApiError('HITLy createApproval response missing id', status, 'malformed_response')
    }
    return {
      id: record.id,
      status: (typeof record.status === 'string' ? record.status : 'pending') as ApprovalRef['status'],
    }
  }

  async getApproval(id: string): Promise<ApprovalAuthorityState> {
    const { status, body } = await this.request(
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/integrations/mastra-factory/approvals/${encodeURIComponent(id)}`,
      { method: 'GET' },
    )
    if (status !== 200) throw HitlyClient.errorFrom(status, body)
    const record = (body ?? {}) as Record<string, unknown>
    const state: ApprovalAuthorityState = {
      id: typeof record.id === 'string' ? record.id : id,
      status: typeof record.status === 'string' ? record.status : 'pending',
      decision: typeof record.decision === 'string' ? record.decision : null,
      metadata: typeof record.metadata === 'object' && record.metadata !== null ? (record.metadata as Record<string, unknown>) : {},
    }
    if (typeof record.reason === 'string') state.reason = record.reason
    if (typeof record.editedArgs === 'object' && record.editedArgs !== null) state.editedArgs = record.editedArgs as Record<string, unknown>
    if (typeof record.response === 'string') state.response = record.response
    if (typeof record.answer === 'string') state.answer = record.answer
    return state
  }

  /** Open gate approvals for restart reconciliation (unexpired pending + decided-but-undelivered failed_resume), with create-time metadata. */
  async listPending(): Promise<Array<{ id: string; status: string; decision: string | null; metadata: Record<string, unknown> }>> {
    const { status, body } = await this.request(`/api/v1/projects/${encodeURIComponent(this.projectId)}/integrations/mastra-factory/approvals`, {
      method: 'GET',
    })
    if (status !== 200) throw HitlyClient.errorFrom(status, body)
    const record = (body ?? {}) as Record<string, unknown>
    const items = Array.isArray(record.approvals) ? (record.approvals as Array<Record<string, unknown>>) : []
    return items
      .filter((item) => typeof item.id === 'string' && typeof item.status === 'string')
      .map((item) => ({
        id: item.id as string,
        status: item.status as string,
        decision: typeof item.decision === 'string' ? item.decision : null,
        metadata: typeof item.metadata === 'object' && item.metadata !== null ? (item.metadata as Record<string, unknown>) : {},
      }))
  }

  /**
   * Host receipt for a converged `failed_resume` decision: HITLy settles the
   * row to `decided` so it leaves the restart-seed feed and never replays.
   * Idempotent — re-acking a settled row is a plain success.
   */
  async ackResume(approvalId: string): Promise<void> {
    const { status, body } = await this.request(
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/integrations/mastra-factory/approvals/${encodeURIComponent(approvalId)}/resume-ack`,
      { method: 'POST' },
    )
    if (status !== 200) throw HitlyClient.errorFrom(status, body)
  }

  async getIntegrationConfig(): Promise<RemoteIntegrationConfig> {
    const { status, body } = await this.request(
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/integrations/mastra-factory`,
      { method: 'GET' },
    )
    if (status !== 200) throw HitlyClient.errorFrom(status, body)
    const record = (body ?? {}) as Record<string, unknown>
    const gates = (typeof record.gates === 'object' && record.gates !== null ? record.gates : {}) as Record<string, unknown>
    return {
      gates: {
        plan: gates.plan !== false,
        review: gates.review !== false,
        ask_user: gates.ask_user !== false,
      },
      mergeAfterAccept: record.mergeAfterAccept === true,
    }
  }
}
