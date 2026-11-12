/**
 * Server-only email for public sign-up verification (branded HTML + plain
 * text). The one-time token is carried only by the confirm-page link.
 *
 * Split from lib/email-verification.ts (client-safe) so client components
 * never pull the branded renderer into their bundle.
 */

import { renderEmailVerificationEmail } from '@hitly/mail'
import { buildEmailVerificationPageUrl, EMAIL_VERIFICATION_TTL_HOURS } from './email-verification'
import type { MailFn } from './password-reset'
import type { MailSendTracker } from './password-reset-emails'

export async function buildEmailVerificationMessage({ to, link }: { to: string; link: string }) {
  const rendered = await renderEmailVerificationEmail({
    appUrl: new URL(link).origin,
    link,
    ttlHours: EMAIL_VERIFICATION_TTL_HOURS,
  })
  return { to, ...rendered }
}

export function createSendEmailVerification(appUrl: string, send: MailFn, opts: { track?: MailSendTracker } = {}) {
  return async ({ to, token }: { to: string; token: string }) => {
    const link = buildEmailVerificationPageUrl(appUrl, token)
    const chain = buildEmailVerificationMessage({ to, link })
      .then((message) => send(message))
      .catch(() => {
        console.error('[hitly email-verification] Failed to send verification email')
      })
    opts.track?.(chain)
  }
}
