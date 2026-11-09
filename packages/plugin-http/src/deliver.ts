import {
  checkedFetch,
  destinationErrorMessage,
  destinationHost,
  destinationStatusMessage,
  DestinationCheckError,
} from '@hitly/core/destination-check'
import type { ResumeResponse } from '@hitly/core'
import { buildSignatureHeaders } from './sign.ts'
import { readCbAuthToken, redactSecrets } from './secrets.ts'

/** Default in-process backoff schedule (ms). Full ~24h fan-out uses host failed_resume retries. */
export const DEFAULT_BACKOFF_MS = [0, 200, 800] as const

export interface DeliverHttpArgs {
  resumeUrl: string
  /** Raw JSON string — signature covers these exact bytes. */
  rawBody: string
  eventId: string
  /** Optional per-request Bearer token (never logged). */
  cbAuthToken?: string
  /** Per-project signing secret (credentials.resumeSecret). */
  signingSecret?: string
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
    if (backoff[i]! > 0) await sleep(backoff[i]!)
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
      if (error instanceof DestinationCheckError) {
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

export function resolveSigningSecret(credentials: Record<string, unknown> | undefined): string | undefined {
  if (!credentials) return undefined
  const secret = credentials.resumeSecret ?? credentials.webhookSigningSecret
  return typeof secret === 'string' && secret.trim() ? secret.trim() : undefined
}

export { readCbAuthToken }
