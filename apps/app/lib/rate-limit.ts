/**
 * App wiring for the shared Postgres-backed rate limiter
 * (`@hitly/db/rate-limit`). Every limited route family counts into the same
 * database, so limits hold across server processes; when the database is
 * unavailable each family transparently falls back to per-process counting
 * (logged once by the shared limiter) and the endpoint stays protected.
 *
 * Route families (bucket `route`, subject in parentheses):
 *   auth                    Better Auth endpoints (client IP + path, hashed)
 *   mfa-reauth / mfa-verify (client address)
 *   password-change         (client address)
 *   passkey-reauth          (client address)
 *   email-change            (client address)
 *   resend-email-verification (client address)
 *   reset-check / reset-check-shared (client address / shared unknown bucket)
 *   reset-email             (SHA-256 of the normalised email)
 *   ingest                  (SHA-256 of the project API key)
 *
 * No raw subject is ever stored or logged: the shared limiter keys on
 * SHA-256(route + NUL + subject), and these helpers hash emails and API keys
 * before handing the subject over. Limits and windows come from
 * HITLY_RATE_LIMIT_<NAME>_LIMIT / HITLY_RATE_LIMIT_<NAME>_WINDOW_MS (whole
 * numbers; invalid values fail at start naming the variable), defaulting to
 * the per-family constants the per-process limiters used.
 */

import {
  createSharedRateLimiter,
  rateLimitRuleFromEnv,
  type RateLimitDecision,
  type RateLimitRule,
  type SharedRateLimiter,
} from '@hitly/db/rate-limit'
import { pool } from './db'
import { hashApiKey } from './keys'

export type { RateLimitDecision, RateLimitRule } from '@hitly/db/rate-limit'

export type Awaitable<T> = T | Promise<T>

/** What a route's injected limiter may answer: a plain boolean or a decision. */
export type RateAcquireOutcome = boolean | RateLimitDecision
export type RateAcquire = (subject: string) => Awaitable<RateAcquireOutcome>

/** Set HITLY_RATE_LIMIT_DB=0 to keep every family on per-process counting. */
export const RATE_LIMIT_DB_ENV = 'HITLY_RATE_LIMIT_DB'

export function rateLimitDbEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[RATE_LIMIT_DB_ENV] ?? '').trim() !== '0'
}

let shared: SharedRateLimiter | null = null

/** The process-wide limiter; the database is used when a pool exists. */
export function sharedRateLimiter(): SharedRateLimiter {
  if (!shared) {
    shared = createSharedRateLimiter({ pool: pool && rateLimitDbEnabled() ? pool : null })
  }
  return shared
}

/** Only for tests: swap the process-wide limiter (null restores the default). */
export function setSharedRateLimiterForTests(replacement: SharedRateLimiter | null): void {
  shared = replacement
}

/**
 * A route-family acquirer: resolves the family's rule from env once, then
 * counts (family, subject) through the shared limiter.
 */
export function createRateAcquire(
  name: string,
  defaults: RateLimitRule,
  env: Record<string, string | undefined> = process.env,
): (subject: string) => Promise<RateLimitDecision> {
  let rule: RateLimitRule | null = null
  return async (subject: string) => {
    if (!rule) rule = rateLimitRuleFromEnv(name, defaults, env)
    return sharedRateLimiter().acquire(name, subject, rule)
  }
}

/** Normalise an injected boolean-or-decision limiter answer. */
export async function resolveDecision(
  acquire: RateAcquire,
  subject: string,
  fallbackRetryAfterMs: number,
): Promise<RateLimitDecision> {
  const outcome = await acquire(subject)
  if (typeof outcome === 'boolean') {
    return { allowed: outcome, retryAfterMs: outcome ? 0 : fallbackRetryAfterMs, count: 0 }
  }
  return outcome
}

/** Attach Retry-After (whole seconds, at least 1) to a 429 response. */
export function withRetryAfter<T extends { headers: Headers }>(response: T, retryAfterMs: number): T {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  response.headers.set('retry-after', String(seconds))
  return response
}

/** Subjects are hashed here when they could be secrets (API keys). */
export function hashIngestSubject(apiKey: string): string {
  return hashApiKey(apiKey)
}

/* ------------------------------------------------------------------ */
/* Better Auth endpoint limiter (the /api/auth surface).               */
/* ------------------------------------------------------------------ */

/**
 * HITLY_RATE_LIMIT_AUTH_ENABLED forces Better Auth's limiter on/off; the
 * default keeps Better Auth's own rule (production only), so test and dev
 * sign-in storms are unaffected while production counts in the database.
 */
export const AUTH_RATE_LIMIT_ENABLED_ENV = 'HITLY_RATE_LIMIT_AUTH_ENABLED'

export function authRateLimitEnabled(env: Record<string, string | undefined> = process.env): boolean | undefined {
  const raw = (env[AUTH_RATE_LIMIT_ENABLED_ENV] ?? '').trim()
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  return undefined
}

/**
 * Better Auth storage adapter over the shared bucket table. `consume` is the
 * atomic path Better Auth prefers; get/set exist only to satisfy the storage
 * interface (the legacy path is never taken while `consume` is present).
 */
export function createAuthRateLimitStorage(limiter: () => SharedRateLimiter = sharedRateLimiter) {
  return {
    async consume(
      key: string,
      rule: { window: number; max: number },
    ): Promise<{ allowed: boolean; retryAfter: number | null }> {
      const decision = await limiter().acquire('auth', key, {
        limit: rule.max,
        windowMs: Math.max(1, rule.window) * 1000,
      })
      return { allowed: decision.allowed, retryAfter: decision.allowed ? null : Math.max(1, Math.ceil(decision.retryAfterMs / 1000)) }
    },
    async get(_key: string) {
      return null
    },
    async set(_key: string, _value: unknown, _update?: boolean) {
      /* unused: consume is the only path Better Auth takes with an atomic storage */
    },
  }
}
