/**
 * Shared-database rate limiting for the public REST /api/v1 surface
 * (everything not already covered by a dedicated family such as `ingest`).
 *
 * Families and defaults (env overrides follow the usual pattern
 * HITLY_RATE_LIMIT_REST_READ_LIMIT / _WINDOW_MS etc., whole numbers):
 *   rest-read  600/min — GETs and session-authed requests
 *   rest-write 120/min — key/token-authed mutations
 *   invite      30/min — invite lookup/accept attempts
 *
 * Subjects never carry raw secrets: API keys go in as SHA-256 via
 * hashApiKey(), invite/housekeeping capabilities as SHA-256 of the token,
 * anonymous callers as the hashed client-address key, and session-authed
 * requests as the (non-secret, already-opaque) session user id. The shared
 * limiter itself stores nothing but SHA-256(route + NUL + subject).
 *
 * When the database is unavailable the shared limiter logs once per process
 * and counts per-process, so the REST surface stays protected without Postgres.
 */

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { hashApiKey } from './keys'
import { resetCheckClientKey } from './reset-check-limit'
import { createRateAcquire, withRetryAfter, type RateLimitDecision } from './rate-limit'

export const REST_READ_LIMIT = 600
export const REST_READ_WINDOW_MS = 60_000
export const REST_WRITE_LIMIT = 120
export const REST_WRITE_WINDOW_MS = 60_000
export const INVITE_LIMIT = 30
export const INVITE_WINDOW_MS = 60_000

export function restLimitedLog(kind: RestLimitKind): string {
  return `[hitly rest] Request refused: too many requests (${kind}).`
}

export type RestLimitKind = 'read' | 'write' | 'invite'

const acquirers: Record<RestLimitKind, (subject: string) => Promise<RateLimitDecision>> = {
  read: createRateAcquire('rest-read', { limit: REST_READ_LIMIT, windowMs: REST_READ_WINDOW_MS }),
  write: createRateAcquire('rest-write', { limit: REST_WRITE_LIMIT, windowMs: REST_WRITE_WINDOW_MS }),
  invite: createRateAcquire('invite', { limit: INVITE_LIMIT, windowMs: INVITE_WINDOW_MS }),
}

/** SHA-256 hex — for capability-shaped values (invite tokens, cron tokens). */
export function hashRestSubject(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Project API keys enter the limiter only as their SHA-256. */
export function apiKeyRestSubject(apiKey: string): string {
  return hashApiKey(apiKey)
}

/** Anonymous callers are keyed by the client-address key, never a raw IP. */
export function clientAddressRestSubject(headers: Headers): string {
  return 'addr:' + resetCheckClientKey(headers)
}

/**
 * Count one request against the family budget. Returns null when allowed, or
 * a ready-to-send 429 with `Retry-After` seconds when the budget is spent.
 * `acquire` is injectable for tests.
 */
export async function applyRestLimit(
  kind: RestLimitKind,
  subject: string,
  acquire: (subject: string) => Promise<RateLimitDecision> | RateLimitDecision = acquirers[kind],
): Promise<NextResponse | null> {
  const decision = await acquire(subject)
  if (decision.allowed) return null
  console.warn(restLimitedLog(kind))
  return withRetryAfter(NextResponse.json({ error: 'too_many_requests' }, { status: 429 }), decision.retryAfterMs)
}
