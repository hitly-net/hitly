/**
 * Server-only passkey-added security notice (branded HTML + plain text).
 *
 * Split from lib/passkey.ts (client-safe) so the branded renderer never
 * reaches the client bundle — the same shape as password-change-emails.ts.
 * The email carries no token, no link, and never any credential material.
 */

import { renderPasskeyAddedEmail } from '@hitly/mail'
import type { MailFn } from './password-reset'

export async function buildPasskeyAddedEmail({ to }: { to: string }) {
  const rendered = await renderPasskeyAddedEmail({
    appUrl: process.env.BETTER_AUTH_URL ?? 'https://hitly.net',
  })
  return { to, ...rendered }
}

/**
 * The notification email sent after a successful passkey registration, on
 * the app's mail path (the same send function the reset email uses).
 * Sending is not awaited: the reply does not depend on delivery.
 */
export function createSendPasskeyAddedNotice(send: MailFn) {
  return async ({ email }: { email: string }) => {
    // Fire-and-forget; the send chain is caught so a mail failure never
    // surfaces to the registration response.
    void buildPasskeyAddedEmail({ to: email })
      .then((message) => send(message))
      .catch((error: unknown) => {
        console.error(
          '[hitly passkey] Failed to send passkey-added email:',
          error instanceof Error ? error.message : error,
        )
      })
  }
}
