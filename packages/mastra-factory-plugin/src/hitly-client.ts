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
 * - POST /api/v1/approvals            (create; Idempotency-Key create-once)
 * - GET  /api/v1/approvals/:id        (authoritative approval state)
 * - GET  /api/v1/approvals?status=pending (reconciliation list)
 * - GET  /api/v1/projects/:id/integrations/mastra-factory (gate config)
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
    const { status, body } = await this.request(`/api/v1/approvals/${encodeURIComponent(id)}`, { method: 'GET' })
    if (status !== 200) throw HitlyClient.errorFrom(status, body)
    const record = (body ?? {}) as Record<string, unknown>
    return {
      id: typeof record.id === 'string' ? record.id : id,
      status: typeof record.status === 'string' ? record.status : 'pending',
      decision: typeof record.decision === 'string' ? record.decision : null,
      metadata: typeof record.metadata === 'object' && record.metadata !== null ? (record.metadata as Record<string, unknown>) : {},
    }
  }

  async listPending(): Promise<{ approvals: Array<{ id: string; status: string }> }> {
    const { status, body } = await this.request('/api/v1/approvals?status=pending&limit=200', { method: 'GET' })
    if (status !== 200) throw HitlyClient.errorFrom(status, body)
    const record = (body ?? {}) as Record<string, unknown>
    const approvals = Array.isArray(record.approvals) ? (record.approvals as Array<{ id: string; status: string }>) : []
    return { approvals }
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
