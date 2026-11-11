/**
 * Server-only password-reset email (branded HTML + plain text).
 *
 * Lives apart from lib/password-reset.ts, which client components import —
 * the branded renderer pulls React-email machinery that must never reach
 * the client bundle. The Better Auth `sendResetPassword` hook and the
 * message builder both live here.
 *
 * The one-time token appears only in the reset link (by design, it is the
 * intended carrier); nothing else secret goes into this email.
 */

import { renderPasswordResetEmail } from '@hitly/mail'
import { buildResetPageUrl, type MailFn } from './password-reset'

/** Matches Better Auth's resetPasswordTokenExpiresIn (3600s) in lib/auth-email-password.ts. */
export const RESET_TOKEN_TTL_HOURS = 1

export async function buildResetEmail({ to, link }: { to: string; link: string }) {
  const rendered = await renderPasswordResetEmail({
    appUrl: new URL(link).origin,
    link,
    ttlHours: RESET_TOKEN_TTL_HOURS,
  })
  return { to, ...rendered }
}

/**
 * Client-safe wording stays in lib/password-reset.ts; the reset email is
 * sent here. Sending is not awaited, so the response time and body are the
 * same whether or not the account exists.
 */
export function createSendResetPassword(appUrl: string, send: MailFn) {
  return async ({ user, token }: { user: { email: string }; url: string; token: string }) => {
    const link = buildResetPageUrl(appUrl, token)
    void buildResetEmail({ to: user.email, link })
      .then((message) => send(message))
      .catch((error: unknown) => {
        console.error(
          '[hitly password-reset] Failed to send reset email:',
          error instanceof Error ? error.message : error,
        )
      })
  }
}
