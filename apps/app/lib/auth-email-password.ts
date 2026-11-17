import { createSendResetPassword, type MailSendTracker } from './password-reset-emails'
import { MIN_PASSWORD_LENGTH } from './password-reset'
import { limitResetEmails } from './reset-request-limit'
import type { RateAcquire } from './rate-limit'

type MailFn = Parameters<typeof createSendResetPassword>[1]

/**
 * Email and password options for Better Auth. Kept free of database and
 * environment imports so tests can mount the same settings on an in-memory
 * adapter. Each call gets its own per-account reset email limiter
 * (lib/reset-request-limit.ts, shared-database counting with a per-process
 * fallback) unless one is passed in.
 */
export function emailAndPasswordOptions(
  appUrl: string,
  send: MailFn,
  {
    allowResetEmail,
    track,
  }: { allowResetEmail?: RateAcquire; track?: MailSendTracker } = {},
) {
  return {
    enabled: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: limitResetEmails(createSendResetPassword(appUrl, send, { track }), allowResetEmail),
  }
}
