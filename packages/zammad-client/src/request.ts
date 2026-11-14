import { ZammadApiError, ZammadResponseShapeError, ZammadTransportError } from './errors.ts'

export type ZammadHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ZammadClientConfig {
  /** Zammad base URL, e.g. https://zammad.example.test (no trailing slash needed). */
  baseUrl: string
  /**
   * Zammad API token, sent as `Authorization: Token token=<token>`.
   * Never logged and never embedded in error messages.
   */
  token: string
  /** Injectable fetch (tests pass a mock). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /**
   * Per-attempt delays in ms; the array length is the max attempt count.
   * Only used between retries (429 / 5xx), so the first attempt is immediate
   * when the schedule starts with 0.
   */
  backoffMs?: readonly number[]
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>
}

/** Retry schedule: up to 3 attempts, ~0.5 s then ~2 s (plus jitter). */
export const DEFAULT_BACKOFF_MS = [0, 500, 2000] as const

/** Fraction of the base delay added as uniform random jitter. */
const JITTER_RATIO = 0.25

function jitteredDelay(ms: number): number {
  return ms + Math.floor(Math.random() * Math.ceil(ms * JITTER_RATIO))
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** True for the ONLY statuses the retry policy covers: 429 and 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** Path without query string, for error messages (keeps search terms out of logs). */
function errorPath(path: string): string {
  const q = path.indexOf('?')
  return q === -1 ? path : path.slice(0, q)
}

export type ZammadRawRequest = <T>(method: ZammadHttpMethod, path: string, body?: unknown) => Promise<T>

/**
 * Build the shared request function used by both the main client and the
 * publisher entry point.
 *
 * Retry policy (deliberate, per product brief):
 * - HTTP 429 and 5xx are retried with the backoff schedule.
 * - Every other non-2xx (the rest of 4xx) fails immediately.
 * - A thrown fetch (transport-level failure) is NOT retried — it carries no
 *   status code, so it is outside the 429/5xx policy.
 */
export function buildRequest(config: ZammadClientConfig): ZammadRawRequest {
  const doFetch = config.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new TypeError('No fetch available: pass config.fetch or run on a platform with global fetch')
  }
  const backoff = config.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = config.sleep ?? defaultSleep
  const base = config.baseUrl.replace(/\/+$/, '')
  const token = config.token

  return async function request<T>(method: ZammadHttpMethod, path: string, body?: unknown): Promise<T> {
    const url = `${base}${path}`
    const pathForErrors = errorPath(path)
    const headers: Record<string, string> = {
      authorization: `Token token=${token}`,
      accept: 'application/json',
    }
    const hasBody = body !== undefined
    if (hasBody) headers['content-type'] = 'application/json'

    let lastError: ZammadApiError | undefined
    for (let attempt = 0; attempt < backoff.length; attempt++) {
      const delay = backoff[attempt]!
      if (attempt > 0 && delay > 0) await sleep(jitteredDelay(delay))

      let response: Response
      try {
        response = await doFetch(url, {
          method,
          headers,
          ...(hasBody ? { body: JSON.stringify(body) } : {}),
        })
      } catch (cause) {
        throw new ZammadTransportError({ method, path: pathForErrors, cause })
      }

      if (isRetryableStatus(response.status)) {
        lastError = new ZammadApiError({
          method,
          path: pathForErrors,
          status: response.status,
          statusText: response.statusText,
        })
        continue // next attempt, or fall through to throw after the last one
      }
      if (!response.ok) {
        // Other 4xx (and any non-retryable non-2xx): fail immediately.
        throw new ZammadApiError({
          method,
          path: pathForErrors,
          status: response.status,
          statusText: response.statusText,
        })
      }
      if (response.status === 204) return undefined as T
      try {
        return (await response.json()) as T
      } catch (cause) {
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
