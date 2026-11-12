import { createRateLimiter, type RateLimiter } from './reset-check-limit'

/**
 * A per-client limit on signed-in resend requests, using the same limiter
 * factory as email change. Past the limit the route answers 429 without
 * sending another message.
 *
 * The limit is per server process. It never stores or logs an address or a
 * token, and the key is the client address, not the account.
 */

export const RESEND_EMAIL_VERIFICATION_LIMIT = 5
export const RESEND_EMAIL_VERIFICATION_WINDOW_MS = 15 * 60 * 1000
export const RESEND_EMAIL_VERIFICATION_LIMITED_LOG =
  '[hitly email-verification] Resend refused: too many attempts from this client.'

export function createResendEmailVerificationLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({
    limit: RESEND_EMAIL_VERIFICATION_LIMIT,
    windowMs: RESEND_EMAIL_VERIFICATION_WINDOW_MS,
    ...options,
  })
}

export const resendEmailVerificationLimiter = createResendEmailVerificationLimiter()
