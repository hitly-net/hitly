/**
 * A per-client limit on signed-in passkey register/delete attempts, using
 * the same limiter factory as password-change and MFA re-auth. Past the
 * limit the route answers 429 (with Retry-After) without checking the
 * password again.
 *
 * Attempts count into the shared database (lib/rate-limit.ts) so the limit
 * holds across server processes; the per-process factory above is the
 * fallback while the database is unavailable. It never stores or logs a
 * password, and the key is the client address, not the account.
 */

import { createRateLimiter, type RateLimiter } from './reset-check-limit'
import { createRateAcquire } from './rate-limit'

export const PASSKEY_REAUTH_ATTEMPT_LIMIT = 10
export const PASSKEY_REAUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const PASSKEY_REAUTH_LIMITED_LOG =
  '[hitly passkey] Passkey change refused: too many attempts from this client.'

export function createPasskeyReauthLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: PASSKEY_REAUTH_ATTEMPT_LIMIT,
    windowMs: PASSKEY_REAUTH_ATTEMPT_WINDOW_MS,
    ...options,
  })
}

export const passkeyReauthAttemptAcquire = createRateAcquire('passkey-reauth', {
  limit: PASSKEY_REAUTH_ATTEMPT_LIMIT,
  windowMs: PASSKEY_REAUTH_ATTEMPT_WINDOW_MS,
})
