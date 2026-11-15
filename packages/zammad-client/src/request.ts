import { ZammadApiError, ZammadResponseShapeError, ZammadTransportError } from './errors.ts'

export type ZammadHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ZammadClientConfig {
  /** Zammad base URL, e.g. https://zammad.example.test (no trailing slash needed). */
  baseUrl: string
  /**
   * Zammad API token for THIS instance/role, sent as `Authorization: Token token=<token>
   * (per-instance tokens: triage, accounts, security, finance, general,
   * librarian, kb-publisher). Taken ONLY from this config — the client never
   * reads any global env var — and never logged nor embedded in errors.
   */
  token: string
  /** Injectable fetch (tests pass a mock). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /**
   * Per-attempt delays in ms; the array length is the max attempt count.
   * Only used between retries, so the first attempt is immediate when the
   * schedule starts with 0.
   */
  backoffMs?: readonly number[]
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Per-request timeout via AbortController. Default 15000 ms. */
  timeoutMs?: number
}

/** Retry schedule: up to 3 attempts, ~0.5 s then ~2 s (plus jitter). */
export const DEFAULT_BACKOFF_MS = [0, 500, 2000] as const

/** Per-request fetch timeout. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Retry-After on 429 is honoured but capped at this delay. */
export const MAX_RETRY_AFTER_MS = 30_000

/** Fraction of the base delay added as uniform random jitter. */
const JITTER_RATIO = 0.25

function jitteredDelay(ms: number): number {
  return ms + Math.floor(Math.random() * Math.ceil(ms * JITTER_RATIO))
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Retry policy (deliberate, per product brief + fix-round-1 M1):
 * - HTTP 429 is retried for EVERY method (rate limit implies nothing ran).
 * - 5xx is retried only for IDEMPOTENT requests (GET/PUT/PATCH/DELETE and the
 *   publish action POST, which passes idempotent). A non-idempotent POST
 *   (article create, KB draft create, raw POST) is NOT retried on 5xx —
 *   Zammad may already have stored the article, and a re-send would duplicate
 *   it for the customer.
 * - Every other non-2xx fails immediately.
 * - A thrown fetch (transport failure) is never retried, POST or otherwise.
 */
export function isRetryableStatus(status: number, idempotent: boolean): boolean {
  if (status === 429) return true
  return idempotent && status >= 500
}

/** Path without query string, for error messages (keeps search terms out of logs). */
function errorPath(path: string): string {
  const q = path.indexOf('?')
  return q === -1 ? path : path.slice(0, q)
}

/**
 * True when a WRITE method targets a KB answer write path: any
 * .../knowledge_bases/.../answers... resource or the publish/internal/
 * archive/unarchive actions. GETs are never guarded.
 */
export function isKbAnswerWritePath(method: ZammadHttpMethod, path: string): boolean {
  if (method === 'GET') return false
  const p = path.split('?')[0]!
  if (!p.includes('/knowledge_bases')) return false
  if (p.includes('/answers')) return true
  return /\/(publish|internal|archive|unarchive)$/.test(p)
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or null. */
export function parseRetryAfterMs(headerValue: string | null, now: number = Date.now()): number | null {
  if (!headerValue) return null
  const seconds = Number(headerValue)
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return 0
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS)
  }
  const dateMs = Date.parse(headerValue)
  if (!Number.isFinite(dateMs)) return null
  return Math.max(0, Math.min(dateMs - now, MAX_RETRY_AFTER_MS))
}

function readRetryAfterHeader(response: Response, name: string): string | null {
  try {
    return response.headers?.get?.(name) ?? null
  } catch {
    return null
  }
}

/** Best-effort: release the failed response body before scheduling a retry. */
async function drainBody(response: Response): Promise<void> {
  try {
    if (response.body && !response.bodyUsed) await response.body.cancel()
  } catch {
    // Body may already be consumed/locked; nothing safe left to do.
  }
}

export interface RequestOptions {
  /**
   * Set true for idempotent operations whose POST may still retry on 5xx
   * (the publish action). Default policy: PUT/PATCH/DELETE/GET idempotent,
   * POST non-idempotent.
   */
  idempotent?: boolean
}

export type ZammadRawRequest = <T>(
  method: ZammadHttpMethod,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
) => Promise<T>

/** Validate the parts of the config that must never be missing. */
function validateConfig(config: ZammadClientConfig): void {
  if (typeof config.baseUrl !== 'string' || config.baseUrl.length === 0) {
    throw new TypeError('Zammad client requires config.baseUrl')
  }
  if (typeof config.token !== 'string' || config.token.length === 0) {
    throw new TypeError(
      'Zammad client requires config.token (the per-instance API token); it is read ONLY from this config, never from the environment',
    )
  }
}

/**
 * Build the shared request function used by the main client (typed methods +
 * guarded rawRequest) and the publisher entry point.
 */
export function buildRequest(config: ZammadClientConfig): ZammadRawRequest {
  validateConfig(config)
  const doFetch = config.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new TypeError('No fetch available: pass config.fetch or run on a platform with global fetch')
  }
  const backoff = config.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = config.sleep ?? defaultSleep
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const base = config.baseUrl.replace(/\/+$/, '')
  const token = config.token

  return async function request<T>(
    method: ZammadHttpMethod,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = `${base}${path}`
    const pathForErrors = errorPath(path)
    const headers: Record<string, string> = {
      authorization: `Token token=${token}`,
      accept: 'application/json',
    }
    const hasBody = body !== undefined
    if (hasBody) headers['content-type'] = 'application/json'
    const idempotent = opts?.idempotent ?? method !== 'POST'

    let lastError: ZammadApiError | undefined
    let nextDelay: number | undefined
    for (let attempt = 0; attempt < backoff.length; attempt++) {
      if (attempt > 0) {
        const delay = nextDelay ?? jitteredDelay(backoff[attempt]!)
        if (delay > 0) await sleep(delay)
      }
      nextDelay = undefined

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await doFetch(url, {
          method,
          headers,
          ...(hasBody ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        })
      } catch (cause) {
        throw new ZammadTransportError({ method, path: pathForErrors, cause })
      } finally {
        clearTimeout(timer)
      }

      if (isRetryableStatus(response.status, idempotent)) {
        lastError = new ZammadApiError({
          method,
          path: pathForErrors,
          status: response.status,
          statusText: response.statusText,
        })
        if (response.status === 429) {
          const retryAfter = parseRetryAfterMs(readRetryAfterHeader(response, 'Retry-After'))
          if (retryAfter !== null) nextDelay = retryAfter
        }
        await drainBody(response)
        continue // next attempt, or fall through to throw after the last one
      }
      if (!response.ok) {
        // Non-retryable status (every 4xx except 429, and 5xx on a
        // non-idempotent POST): fail immediately with the typed error.
        throw (lastError = new ZammadApiError({
          method,
          path: pathForErrors,
          status: response.status,
          statusText: response.statusText,
        }))
      }
      if (response.status === 204) return undefined as T
      try {
        return (await response.json()) as T
      } catch {
        throw new ZammadResponseShapeError({
          method,
          path: pathForErrors,
          detail: 'body was not valid JSON',
        })
      }
    }
    throw lastError ?? new ZammadApiError({ method, path: pathForErrors, status: 0 })
  }
}

/** Encode a path segment (ticket ids etc. are numbers, but be safe). */
export function enc(segment: string | number): string {
  return encodeURIComponent(String(segment))
}
