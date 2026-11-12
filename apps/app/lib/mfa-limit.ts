/**
 * Limits for MFA password re-auth (enrol / disable / regenerate) and for
 * TOTP / recovery-code verification (login second step, disable, and
 * recovery-code regenerate). In-process calls skip Better Auth's request
 * limiter, so these use the shared factory (lib/reset-check-limit.ts).
 *
 * Per-user lockout lives in user_mfa (failed_verify_count / locked_until).
 * The limiters here are per client address (or the shared bucket): they count
 * into the shared database (lib/rate-limit.ts, @hitly/db/rate-limit) and keep
 * working per-process if the database is unavailable. Nothing here stores or
 * logs a code or password.
 */

import { createRateLimiter, type RateLimiter } from './reset-check-limit'
import { createRateAcquire } from './rate-limit'

export const MFA_REAUTH_ATTEMPT_LIMIT = 10
export const MFA_REAUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const MFA_REAUTH_LIMITED_LOG =
  '[hitly mfa] MFA change refused: too many attempts from this client.'

export const MFA_VERIFY_ATTEMPT_LIMIT = 10
export const MFA_VERIFY_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const MFA_VERIFY_LIMITED_LOG =
  '[hitly mfa] MFA verification refused: too many attempts from this client.'

export const MFA_VERIFY_FAILURE_LIMIT = 5
export const MFA_LOCKOUT_MS = 15 * 60 * 1000
export const MFA_LOCKOUT_LOG = '[hitly mfa] MFA verification locked for this account.'

export function createMfaReauthLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: MFA_REAUTH_ATTEMPT_LIMIT,
    windowMs: MFA_REAUTH_ATTEMPT_WINDOW_MS,
    ...options,
  })
}

export function createMfaVerifyLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: MFA_VERIFY_ATTEMPT_LIMIT,
    windowMs: MFA_VERIFY_ATTEMPT_WINDOW_MS,
    ...options,
  })
}

/**
 * The route defaults: shared-database counting (holds across processes),
 * falling back to the per-process factory above while the database is down.
 * Override with HITLY_RATE_LIMIT_MFA_REAUTH_* / HITLY_RATE_LIMIT_MFA_VERIFY_*.
 */
export const mfaReauthAcquire = createRateAcquire('mfa-reauth', {
  limit: MFA_REAUTH_ATTEMPT_LIMIT,
  windowMs: MFA_REAUTH_ATTEMPT_WINDOW_MS,
})

export const mfaVerifyAcquire = createRateAcquire('mfa-verify', {
  limit: MFA_VERIFY_ATTEMPT_LIMIT,
  windowMs: MFA_VERIFY_ATTEMPT_WINDOW_MS,
})
