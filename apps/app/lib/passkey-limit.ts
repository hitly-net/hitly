/**
 * A per-client limit on signed-in passkey register/delete attempts, using
 * the same limiter factory as password-change and MFA re-auth. Past the
 * limit the route answers 429 without checking the password again.
 *
 * The limit is per server process. It never stores or logs a password, and
 * the key is the client address, not the account.
 */

import { createRateLimiter, type RateLimiter } from './reset-check-limit'

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

export const passkeyReauthLimiter = createPasskeyReauthLimiter()
