/**
 * Server-only emails for the signed-in email change (branded HTML + plain
 * text): the confirmation email to the new address (carries the one-time
 * token link, the intended single carrier) and the security notice to the
 * previous address (never carries a token or link).
 *
 * Split from lib/email-change.ts (client-safe) the same way the route
 * handlers are split into lib/email-change-route.ts: client components must
 * never pull the branded renderer into their bundle.
 */

import { renderEmailChangeVerificationEmail, renderEmailChangedNoticeEmail } from '@hitly/mail'
import {
  buildEmailChangePageUrl,
  EMAIL_CHANGE_TTL_HOURS,
} from './email-change'
import type { MailFn } from './password-reset'
import type { MailSendTracker } from './password-reset-emails'

export async function buildEmailChangeVerificationEmail({ to, link }: { to: string; link: string }) {
  const rendered = await renderEmailChangeVerificationEmail({
    appUrl: new URL(link).origin,
    link,
    ttlHours: EMAIL_CHANGE_TTL_HOURS,
  })
  return { to, ...rendered }
}

export async function buildEmailChangedNotice({ to }: { to: string }) {
  const rendered = await renderEmailChangedNoticeEmail({
    appUrl: process.env.BETTER_AUTH_URL ?? 'https://hitly.net',
  })
  return { to, ...rendered }
}

export function createSendEmailChangeVerification(appUrl: string, send: MailFn, opts: { track?: MailSendTracker } = {}) {
  return async ({ to, token }: { to: string; token: string }) => {
    const link = buildEmailChangePageUrl(appUrl, token)
    // Fire-and-forget; track lets tests drain pending sends deterministically.
    const chain = buildEmailChangeVerificationEmail({ to, link })
      .then((message) => send(message))
      .catch((error: unknown) => {
        console.error(
          '[hitly email-change] Failed to send confirmation email:',
          error instanceof Error ? error.message : error,
        )
      })
    opts.track?.(chain)
  }
}

export function createSendEmailChangedNotice(send: MailFn, opts: { track?: MailSendTracker } = {}) {
  return async ({ to }: { to: string }) => {
    const chain = buildEmailChangedNotice({ to })
      .then((message) => send(message))
      .catch((error: unknown) => {
        console.error(
          '[hitly email-change] Failed to send email-changed notice:',
          error instanceof Error ? error.message : error,
        )
      })
    opts.track?.(chain)
  }
}
