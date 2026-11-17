import { createRateLimiter, type RateLimiter } from './reset-check-limit'
import { createRateAcquire } from './rate-limit'

/**
 * A per-client limit on signed-in email-change requests, using the same
 * limiter factory as password-change. Past the limit the route answers 429
 * (with Retry-After) without checking the password again.
 *
 * Attempts count into the shared database (lib/rate-limit.ts) so the limit
 * holds across server processes; the per-process factory above is the
 * fallback while the database is unavailable. It never stores or logs a
 * password or a token, and the key is the client address, not the account.
 */

export const EMAIL_CHANGE_ATTEMPT_LIMIT = 10
export const EMAIL_CHANGE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const EMAIL_CHANGE_LIMITED_LOG =
  '[hitly email-change] Email change refused: too many attempts from this client.'

export function createEmailChangeAttemptLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: EMAIL_CHANGE_ATTEMPT_LIMIT,
    windowMs: EMAIL_CHANGE_ATTEMPT_WINDOW_MS,
    ...options,
  })
}

export const emailChangeAttemptAcquire = createRateAcquire('email-change', {
  limit: EMAIL_CHANGE_ATTEMPT_LIMIT,
  windowMs: EMAIL_CHANGE_ATTEMPT_WINDOW_MS,
})
