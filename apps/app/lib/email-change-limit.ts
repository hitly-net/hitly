import { createRateLimiter, type RateLimiter } from './reset-check-limit'

/**
 * A per-client limit on signed-in email-change requests, using the same
 * limiter factory as password-change. Past the limit the route answers 429
 * without checking the password again.
 *
 * The limit is per server process. It never stores or logs a password or a
 * token, and the key is the client address, not the account.
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

export const emailChangeAttemptLimiter = createEmailChangeAttemptLimiter()
