import { createSendResetPassword, MIN_PASSWORD_LENGTH } from './password-reset'

type MailFn = Parameters<typeof createSendResetPassword>[1]

/**
 * Email and password options for Better Auth. Kept free of database and
 * environment imports so tests can mount the same settings on an in-memory
 * adapter.
 */
export function emailAndPasswordOptions(appUrl: string, send: MailFn) {
  return {
    enabled: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: createSendResetPassword(appUrl, send),
  }
}
