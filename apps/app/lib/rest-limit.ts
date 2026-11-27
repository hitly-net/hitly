/**
 * Shared-database rate limiting for the public REST /api/v1 surface
 * (everything not already covered by a dedicated family such as `ingest`).
 *
 * Families and defaults (env overrides follow the usual pattern
 * HITLY_RATE_LIMIT_REST_READ_LIMIT / _WINDOW_MS etc.; an unusable or
 * zero-valued override warns at startup and the default is kept):
 *   rest-read     600/min — GETs and session-authed requests
 *   rest-write    120/min — key/token-authed mutations
 *   invite         30/min — invite lookup/accept attempts
 *   failed-auth    60/min — unauthenticated or invalid key/token attempts,
 *                            counted per client ADDRESS only (never per
 *                            unverified subject, so guesses cannot mint
 *                            per-subject buckets)
 *   mcp-verify    600/min — HITLy MCP edge → /api/v1/mcp/verify-token calls,
 *                            keyed by the authenticated caller address, never
 *                            by the presented (rotatable) token
 *
 * The unauthenticated /api/v1/health probe is deliberately NOT limited at
 * all (monitoring must never be throttled and must not write to the DB).
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
export const FAILED_AUTH_LIMIT = 60
export const FAILED_AUTH_WINDOW_MS = 60_000
export const MCP_VERIFY_LIMIT = 600
export const MCP_VERIFY_WINDOW_MS = 60_000

export function restLimitedLog(kind: RestLimitKind): string {
  return `[hitly rest] Request refused: too many requests (${kind}).`
}

export type RestLimitKind = 'read' | 'write' | 'invite' | 'failed-auth' | 'mcp-verify'

const acquirers: Record<RestLimitKind, (subject: string) => Promise<RateLimitDecision>> = {
  read: createRateAcquire('rest-read', { limit: REST_READ_LIMIT, windowMs: REST_READ_WINDOW_MS }),
  write: createRateAcquire('rest-write', { limit: REST_WRITE_LIMIT, windowMs: REST_WRITE_WINDOW_MS }),
  invite: createRateAcquire('invite', { limit: INVITE_LIMIT, windowMs: INVITE_WINDOW_MS }),
  'failed-auth': createRateAcquire('failed-auth', { limit: FAILED_AUTH_LIMIT, windowMs: FAILED_AUTH_WINDOW_MS }),
  // /api/v1/mcp/verify-token calls from the HITLy MCP edge: keyed by the
  // authenticated caller (address behind the shared secret), never by the
  // presented token — rotating throwaway tokens cannot mint fresh budgets.
  'mcp-verify': createRateAcquire('mcp-verify', { limit: MCP_VERIFY_LIMIT, windowMs: MCP_VERIFY_WINDOW_MS }),
}

export type RestLimitAcquire = (subject: string) => Promise<RateLimitDecision> | RateLimitDecision

let acquireOverride: ((kind: RestLimitKind, subject: string) => Promise<RateLimitDecision> | RateLimitDecision) | null = null

/**
 * Test seam: force every family's decision (e.g. always DENY) so a route-level
 * test proves the route actually consults the limiter before doing work.
 * Passing null restores the real limiters.
 */
export function setRestLimitAcquireOverrideForTests(
  fn: ((kind: RestLimitKind, subject: string) => Promise<RateLimitDecision> | RateLimitDecision) | null,
): void {
  acquireOverride = fn
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
 * `acquire` is injectable for tests (as is the global seam above).
 */
export async function applyRestLimit(
  kind: RestLimitKind,
  subject: string,
  acquire?: RestLimitAcquire,
): Promise<NextResponse | null> {
  const decision = await (acquire ?? acquireOverride?.bind(null, kind) ?? acquirers[kind])(subject)
  if (decision.allowed) return null
  console.warn(restLimitedLog(kind))
  return withRetryAfter(NextResponse.json({ error: 'too_many_requests' }, { status: 429 }), decision.retryAfterMs)
}

/**
 * Count an unauthenticated / invalid-credential attempt against the shared
 * per-CLIENT-ADDRESS failed-auth budget. Never keyed by the presented (and
 * therefore unverified) key or token. Returns null when allowed, or a 429
 * with `Retry-After` when that address has spent its budget.
 */
export function applyFailedAuthLimit(request: Request, acquire?: RestLimitAcquire): Promise<NextResponse | null> {
  return applyRestLimit('failed-auth', clientAddressRestSubject(request.headers), acquire)
}
