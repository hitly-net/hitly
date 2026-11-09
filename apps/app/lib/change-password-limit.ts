import { createRateLimiter, type RateLimiter } from './reset-check-limit'

/**
 * A per-client limit on signed-in password-change attempts, on top of
 * Better Auth's own limiter for the /change-password API path. The app's
 * route calls Better Auth in process, which skips Better Auth's request
 * limiter (see lib/reset-check-limit.ts for the same reasoning on the reset
 * link check), so attempts are counted here with the shared limiter factory:
 * past the limit the route answers 429 without checking the password again.
 *
 * The limit is per server process. It never stores or logs a password, and
 * the key is the client address, not the account.
 */

export const CHANGE_PASSWORD_ATTEMPT_LIMIT = 10
export const CHANGE_PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const CHANGE_PASSWORD_LIMITED_LOG =
  '[hitly password-change] Password change refused: too many attempts from this client.'

export function createChangePasswordAttemptLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: CHANGE_PASSWORD_ATTEMPT_LIMIT,
    windowMs: CHANGE_PASSWORD_ATTEMPT_WINDOW_MS,
    ...options,
  })
}

export const changePasswordAttemptLimiter = createChangePasswordAttemptLimiter()
