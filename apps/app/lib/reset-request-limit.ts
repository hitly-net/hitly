import { createHash } from 'node:crypto'
import { createRateLimiter, type RateLimiter } from './reset-check-limit'

/**
 * A per-account limit on password reset emails, on top of Better Auth's
 * per-address request limit. Better Auth calls `sendResetPassword` only for
 * accounts that exist; past the limit the email is skipped and the request
 * still gets the usual neutral reply, so nothing reveals whether the account
 * exists or was limited.
 *
 * The limiter keys on a hash of the normalised email, so the table holds no
 * addresses, and the log line names neither the email nor the token. The limit
 * is per server process.
 */

export const RESET_EMAIL_LIMIT = 5
export const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000
export const RESET_EMAIL_LIMITED_LOG = '[hitly password-reset] Reset email not sent: too many requests for this account.'

export function resetEmailKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

export function createResetEmailLimiter(options: { now?: () => number } = {}): RateLimiter {
  return createRateLimiter({ limit: RESET_EMAIL_LIMIT, windowMs: RESET_EMAIL_WINDOW_MS, ...options })
}

type SendResetPassword<A extends { user: { email: string } }> = (args: A) => Promise<void>

/** Wraps Better Auth's `sendResetPassword` hook with the per-account limit. */
export function limitResetEmails<A extends { user: { email: string } }>(
  send: SendResetPassword<A>,
  allow: (key: string) => boolean = createResetEmailLimiter(),
  log: (line: string) => void = (line) => console.warn(line),
): SendResetPassword<A> {
  return async (args) => {
    if (!allow(resetEmailKey(args.user.email))) {
      log(RESET_EMAIL_LIMITED_LOG)
      return
    }
    await send(args)
  }
}
