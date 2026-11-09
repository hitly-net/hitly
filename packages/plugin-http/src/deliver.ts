import {
  checkedFetch,
  destinationErrorMessage,
  destinationHost,
  destinationStatusMessage,
  DestinationCheckError,
  type DestinationCheckCode,
} from '@hitly/core/destination-check'
import type { ResumeResponse } from '@hitly/core'
import { buildSignatureHeaders, pickActiveSigningKey, type SigningKeyEntry } from './sign.ts'
import { readCbAuthToken, redactSecrets } from './secrets.ts'

/** Default in-process backoff schedule (ms). Full ~24h fan-out uses host failed_resume retries. */
export const DEFAULT_BACKOFF_MS = [0, 200, 800] as const

/**
 * Destination-check failures that look like transient network trouble rather
 * than a policy refusal: retry them on the next attempt (which re-resolves and
 * re-pins DNS). Refusals, redirects, size and malformed URLs stay fail-closed.
 */
const TRANSIENT_CHECK_CODES: ReadonlySet<DestinationCheckCode> = new Set(['timeout', 'connect'])

/** Fraction of the base delay added as uniform random jitter (spreads retry storms). */
const JITTER_RATIO = 0.25

function jitteredDelay(ms: number): number {
  return ms + Math.floor(Math.random() * Math.ceil(ms * JITTER_RATIO))
}

export interface DeliverHttpArgs {
  resumeUrl: string
  /** Raw JSON string — signature covers these exact bytes. */
  rawBody: string
  eventId: string
  /** Optional per-request Bearer token (never logged). */
  cbAuthToken?: string
  /**
   * Per-project WEBHOOK signing secret (credentials.webhookSigningSecrets —
   * never HITLY_RESUME_SECRET / credentials.resumeSecret, which authenticates
   * origin→HITLy polls, not HITLy→origin callbacks).
   */
  signingSecret?: string
  /** Stored key id advertised in X-HITLy-Key-Id (defaults to the derived hk_ id). */
  signingKeyId?: string
  backoffMs?: readonly number[]
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>
  totalTimeoutMs?: number
}

export interface DeliverHttpResult {
  response: ResumeResponse
  attempts: number
  deduped?: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * POST a callback through the shared destination check on EVERY attempt
 * (including retries). Applies Bearer + HMAC headers when configured.
 */
export async function deliverHttpCallback(args: DeliverHttpArgs): Promise<DeliverHttpResult> {
  const backoff = args.backoffMs ?? DEFAULT_BACKOFF_MS
  const sleep = args.sleep ?? defaultSleep
  const host = destinationHost(args.resumeUrl)
  let lastError: unknown
  let lastStatus = 0
  let attempts = 0

  for (let i = 0; i < backoff.length; i++) {
    if (backoff[i]! > 0) await sleep(jitteredDelay(backoff[i]!))
    attempts++

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (args.cbAuthToken) {
      headers.authorization = `Bearer ${args.cbAuthToken}`
    }
    if (args.signingSecret) {
      Object.assign(
        headers,
        buildSignatureHeaders({
          secret: args.signingSecret,
          eventId: args.eventId,
          rawBody: args.rawBody,
          keyId: args.signingKeyId,
        }),
      )
    } else {
      headers['x-hitly-event-id'] = args.eventId
    }

    try {
      const response = await checkedFetch(
        args.resumeUrl,
        { method: 'POST', headers, body: args.rawBody },
        { totalTimeoutMs: args.totalTimeoutMs ?? 60_000 },
      )
      const text = await response.text()
      let body: unknown = text || null
      if (text) {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          body = text
        }
      }
      lastStatus = response.status

      if (response.ok) {
        const parsed = safeParse(args.rawBody)
        return {
          attempts,
          response: {
            resumeData: redactSecrets(parsed),
            status: response.status,
            body,
          },
        }
      }

      if (response.status < 500 && response.status !== 429 && response.status !== 408 && response.status !== 425) {
        return {
          attempts,
          response: {
            resumeData: redactSecrets(safeParse(args.rawBody)),
            status: response.status,
            body: null,
            error: destinationStatusMessage('HTTP resume', response.status, host),
          },
        }
      }
      lastError = new Error(destinationStatusMessage('HTTP resume', response.status, host))
    } catch (error) {
      lastError = error
      // Fail-closed refusals (SSRF, redirects, size, malformed URL) throw at once;
      // transient connect/timeout failures fall through to the next attempt.
      if (error instanceof DestinationCheckError && !TRANSIENT_CHECK_CODES.has(error.code)) {
        throw error
      }
    }
  }

  const message =
    lastError instanceof DestinationCheckError
      ? lastError.message
      : lastStatus
        ? destinationStatusMessage('HTTP resume', lastStatus, host)
        : destinationErrorMessage('HTTP resume', lastError, host)

  return {
    attempts,
    response: {
      resumeData: redactSecrets(safeParse(args.rawBody)),
      status: lastStatus || 0,
      body: null,
      error: message,
    },
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // ignore
  }
  return {}
}

/**
 * Resolve the per-project WEBHOOK signing key from project credentials.
 *
 * Callbacks are signed with a DEDICATED webhook secret, never with the resume
 * secret (HITLY_RESUME_SECRET on the origin side): one credential authenticates
 * origin→HITLy polls, the other authenticates HITLy→origin callbacks. A project
 * may carry several keys during a rotation; the newest usable one signs, and
 * rotated-out keys stay verifiable until their `validUntil` (overlap window).
 *
 * Accepted shapes:
 * - `webhookSigningSecrets`: array of { keyId, secret, validUntil?, createdAt? }
 * - `webhookSigningSecret`: legacy single string (key id derived via webhookKeyId)
 * - `credentials.webhookSigningSecret` may also be a single entry object.
 */
export function resolveSigningKey(
  credentials: Record<string, unknown> | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { secret: string; keyId?: string } | undefined {
  if (!credentials) return undefined
  const bag = credentials.webhookSigningSecrets
  if (Array.isArray(bag)) {
    const entries: SigningKeyEntry[] = []
    for (const item of bag) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      if (typeof record.keyId !== 'string' || typeof record.secret !== 'string') continue
      const validUntil =
        typeof record.validUntil === 'number' && Number.isFinite(record.validUntil) ? record.validUntil : null
      const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0
      entries.push({ keyId: record.keyId.trim(), secret: record.secret.trim(), validUntil, createdAt })
    }
    const active = pickActiveSigningKey(entries, nowSeconds)
    if (active) return { secret: active.secret, keyId: active.keyId }
    // An empty/expired registry means "sign nothing" — never fall through to
    // the resume secret: the two credentials must not be conflated.
    return undefined
  }
  const single = credentials.webhookSigningSecret
  if (typeof single === 'string' && single.trim()) return { secret: single.trim() }
  if (single && typeof single === 'object' && !Array.isArray(single)) {
    const record = single as Record<string, unknown>
    if (typeof record.secret === 'string' && record.secret.trim()) {
      const validUntil =
        typeof record.validUntil === 'number' && Number.isFinite(record.validUntil) ? record.validUntil : null
      if (validUntil === null || validUntil > nowSeconds) {
        return {
          secret: record.secret.trim(),
          keyId: typeof record.keyId === 'string' && record.keyId.trim() ? record.keyId.trim() : undefined,
        }
      }
    }
  }
  return undefined
}

/** Secret-only convenience wrapper around `resolveSigningKey` (kept for API compat). */
export function resolveSigningSecret(credentials: Record<string, unknown> | undefined): string | undefined {
  return resolveSigningKey(credentials)?.secret
}

export { readCbAuthToken }
