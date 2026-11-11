/**
 * Server-only password-changed security notice (branded HTML + plain text).
 *
 * Split from lib/password-change.ts (client-safe) so the branded renderer
 * never reaches the client bundle. The email carries no token, no link, and
 * never any password.
 */

import { renderPasswordChangedEmail } from '@hitly/mail'
import type { MailFn } from './password-reset'
import type { MailSendTracker } from './password-reset-emails'

export async function buildPasswordChangedEmail({ to }: { to: string }) {
  const rendered = await renderPasswordChangedEmail({
    appUrl: process.env.BETTER_AUTH_URL ?? 'https://hitly.net',
  })
  return { to, ...rendered }
}

/**
 * The notification email sent after a successful change, on the app's mail
 * path (the same send function the reset email uses). Sending is not
 * awaited: the reply does not depend on delivery.
 */
export function createSendPasswordChangedNotification(send: MailFn, opts: { track?: MailSendTracker } = {}) {
  return async ({ email }: { email: string }) => {
    // Fire-and-forget; track lets tests drain pending sends deterministically.
    const chain = buildPasswordChangedEmail({ to: email })
      .then((message) => send(message))
      .catch((error: unknown) => {
        console.error(
          '[hitly password-change] Failed to send password-changed email:',
          error instanceof Error ? error.message : error,
        )
      })
    opts.track?.(chain)
  }
}
