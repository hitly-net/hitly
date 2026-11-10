/**
 * Thin adapter over the HITLy host HTTP API. The MCP tools only talk to this
 * interface, so switching to the M0 endpoints (fuller API-key reads, requester
 * cancel, key-scoped pending list) is a change here, not in the tools.
 *
 * The client never logs. Callers get status codes and parsed JSON back; host error
 * text is returned to the bot only, never written to logs.
 */

export type HostResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code: HostErrorCode }

export type HostErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'not_supported_by_host'
  | 'host_error'
  | 'unreachable'

export interface IngestResponse {
  id: string
  status: string
  replayed?: boolean
  [key: string]: unknown
}

/** Today's API-key read is `{id, status, decision, response, presentedAt}`; M0 adds hitl/response/v0 fields. */
export interface ApprovalRead {
  id: string
  status: string
  decision?: string
  response?: string
  presentedAt?: string | null
  [key: string]: unknown
}

export interface HostClient {
  ingest(body: Record<string, unknown>, idempotencyKey: string): Promise<HostResult<IngestResponse>>
  getApproval(id: string): Promise<HostResult<ApprovalRead>>
  listPending(projectId?: string, cursor?: string): Promise<HostResult<unknown>>
  cancel(id: string, reason?: string): Promise<HostResult<unknown>>
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

function codeFor(status: number): HostErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 405 || status === 501) return 'not_supported_by_host'
  if (status >= 400 && status < 500) return 'invalid_request'
  return 'host_error'
}

export class HttpHostClient implements HostClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<HostResult<T>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extra,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return { ok: false, status: 502, error: 'HITLy host unreachable', code: 'unreachable' }
    }
    let parsed: unknown = undefined
    const text = await response.text().catch(() => '')
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `HITLy host returned ${response.status}`
      return { ok: false, status: response.status, error: message, code: codeFor(response.status) }
    }
    return { ok: true, status: response.status, data: parsed as T }
  }

  ingest(body: Record<string, unknown>, idempotencyKey: string) {
    return this.call<IngestResponse>('POST', '/api/v1/approvals', body, { 'idempotency-key': idempotencyKey })
  }

  getApproval(id: string) {
    return this.call<ApprovalRead>('GET', `/api/v1/approvals/${encodeURIComponent(id)}`)
  }

  /**
   * DEPENDS ON M0: key-scoped pending list. Today `GET /api/v1/approvals` has no GET
   * handler (405) and the inbox is session-only, so this reports not_supported_by_host.
   */
  listPending(projectId?: string, cursor?: string) {
    const query = new URLSearchParams({ status: 'pending' })
    if (projectId) query.set('projectId', projectId)
    if (cursor) query.set('cursor', cursor)
    return this.call<unknown>('GET', `/api/v1/approvals?${query.toString()}`)
  }

  /** DEPENDS ON M0: requester cancel with a project API key. Today cancel is session-only. */
  cancel(id: string, reason?: string) {
    return this.call<unknown>('POST', `/api/v1/approvals/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {})
  }
}
