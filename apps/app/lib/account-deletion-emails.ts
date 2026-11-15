/**
 * Server-only emails for account deletion: the permanent-deletion
 * confirmation to the deleted address, and the API-key review notice to the
 * admins of workspaces that survive the deletion.
 *
 * Split from lib/account-deletion.ts the same way the route handlers are
 * split into lib/account-deletion-route.ts: client components must never pull
 * the branded renderer into their bundle. Neither email carries a link or a
 * code, so neither can be turned into a phishing vector.
 */

import { renderAccountDeletedEmail, renderMemberDeletedAccountApiKeyReviewEmail } from '@hitly/mail'
import type { MailFn } from './password-reset'

const APP_URL_FALLBACK = 'https://hitly.net'

function appUrl(): string {
  return process.env.BETTER_AUTH_URL ?? APP_URL_FALLBACK
}

export async function buildAccountDeletedEmail({ to }: { to: string }) {
  const rendered = await renderAccountDeletedEmail({ appUrl: appUrl() })
  return { to, ...rendered }
}

export async function buildApiKeyReviewNotice({ to, workspaceName }: { to: string; workspaceName: string }) {
  const rendered = await renderMemberDeletedAccountApiKeyReviewEmail({ appUrl: appUrl(), workspaceName })
  return { to, ...rendered }
}

/** Fire-and-forget senders; `track` lets tests drain pending sends. */
export function createSendAccountDeletedEmail(send: MailFn, opts: { track?: (chain: Promise<unknown>) => void } = {}) {
  return async ({ to }: { to: string }) => {
    const chain = buildAccountDeletedEmail({ to })
      .then((message) => send(message))
      .catch((error: unknown) => {
        console.error(
          '[hitly account-deletion] Failed to send the deletion confirmation email:',
          error instanceof Error ? error.message : error,
        )
      })
    opts.track?.(chain)
  }
}

export function createSendApiKeyReviewNotice(send: MailFn, opts: { track?: (chain: Promise<unknown>) => void } = {}) {
  return async ({ to, workspaceName }: { to: string; workspaceName: string }) => {
    const chain = buildApiKeyReviewNotice({ to, workspaceName })
      .then((message) => send(message))
      .catch((error: unknown) => {
        console.error(
          '[hitly account-deletion] Failed to send the API-key review notice:',
          error instanceof Error ? error.message : error,
        )
      })
    opts.track?.(chain)
  }
}
