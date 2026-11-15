/**
 * Per-client limits for the account-deletion surface, using the same limiter
 * factory as password-change, MFA and passkey re-auth. Past the limit the
 * route answers 429 without checking the password or the ticket again.
 *
 * The limit is per server process, the key is the client address (never the
 * account), and nothing here stores or logs a password or a token.
 */

import { createRateLimiter, type RateLimiter } from './reset-check-limit'

export const DELETION_REAUTH_ATTEMPT_LIMIT = 8
export const DELETION_REAUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const DELETION_REAUTH_LIMITED_LOG =
  '[hitly account-deletion] Deletion re-auth refused: too many attempts from this client.'

export const DELETION_CONFIRM_ATTEMPT_LIMIT = 5
export const DELETION_CONFIRM_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const DELETION_CONFIRM_LIMITED_LOG =
  '[hitly account-deletion] Deletion refused: too many attempts from this client.'

export function createDeletionReauthLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: DELETION_REAUTH_ATTEMPT_LIMIT,
    windowMs: DELETION_REAUTH_ATTEMPT_WINDOW_MS,
    ...options,
  })
}

export function createDeletionConfirmLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: DELETION_CONFIRM_ATTEMPT_LIMIT,
    windowMs: DELETION_CONFIRM_ATTEMPT_WINDOW_MS,
    ...options,
  })
}

export const deletionReauthLimiter = createDeletionReauthLimiter()
export const deletionConfirmLimiter = createDeletionConfirmLimiter()
