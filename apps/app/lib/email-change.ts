/**
 * Signed-in email change (client-safe half): the endpoint constants, the
 * fixed messages, the confirmation and notice email builders, and the client
 * submit helpers used by the security page's form and the confirm page. The
 * route handlers that touch auth, the database and the mailer live in
 * lib/email-change-route.ts, so client components import only this file
 * (same split as the password-change flow).
 *
 * The live account email is not updated until the new address is confirmed.
 * The confirmation token exists only in the email; this module never logs it.
 */

import { CURRENT_PASSWORD_INCORRECT_MESSAGE } from './password-change'
import {
  INVALID_EMAIL_MESSAGE,
  RESET_REQUEST_NETWORK_MESSAGE,
  type MailFn,
} from './password-reset'

export const CHANGE_EMAIL_ENDPOINT = '/api/session/change-email'
export const VERIFY_EMAIL_CHANGE_ENDPOINT = '/api/session/verify-email-change'
export const VERIFY_EMAIL_CHANGE_PAGE = '/verify-email-change'

export const EMAIL_CHANGE_TTL_HOURS = 24
export const EMAIL_CHANGE_TTL_MS = EMAIL_CHANGE_TTL_HOURS * 60 * 60 * 1000

export const CHANGE_EMAIL_UNAUTHENTICATED_MESSAGE = 'Your session has ended. Sign in again to change your email.'
export const CHANGE_EMAIL_THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'
export const CHANGE_EMAIL_FAILED_MESSAGE = 'Could not start the email change. Check the details and try again.'
export const CHANGE_EMAIL_RETRY_MESSAGE = 'Could not start the email change right now. Try again in a moment.'
export const CHANGE_EMAIL_SUCCEEDED_MESSAGE = 'Check your new inbox to confirm the address change.'
export const VERIFY_EMAIL_CHANGE_INVALID_MESSAGE = 'This confirmation link is invalid or has expired.'
export const EMAIL_CHANGED_MESSAGE = 'Your email address has been updated. Sign in with the new address.'

export { CURRENT_PASSWORD_INCORRECT_MESSAGE, INVALID_EMAIL_MESSAGE }

/** Link to the app's confirm page carrying the one-time token. */
export function buildEmailChangePageUrl(appUrl: string, token: string): string {
  const url = new URL(VERIFY_EMAIL_CHANGE_PAGE, appUrl)
  url.searchParams.set('token', token)
  return url.toString()
}

export function buildEmailChangeVerificationEmail({ to, link }: { to: string; link: string }) {
  return {
    to,
    subject: 'HITLy: Confirm your new email address',
    text: [
      'Someone asked to use this address for a HITLy account.',
      '',
      `Open this link to confirm the change (it expires in ${EMAIL_CHANGE_TTL_HOURS} hours):`,
      '',
      link,
      '',
      'If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  }
}

/**
 * Notice sent to the previous address after a confirmed change. Like the
 * password-changed email it carries no secret: no token and no link.
 */
export function buildEmailChangedNotice({ to }: { to: string }) {
  return {
    to,
    subject: 'HITLy: Your email address was changed',
    text: [
      'The email address for your HITLy account was changed.',
      '',
      'If this was not you, reset your password immediately from the HITLy sign-in page.',
    ].join('\n'),
  }
}

export function createSendEmailChangeVerification(appUrl: string, send: MailFn) {
  return async ({ to, token }: { to: string; token: string }) => {
    const message = buildEmailChangeVerificationEmail({
      to,
      link: buildEmailChangePageUrl(appUrl, token),
    })
    void send(message).catch((error: unknown) => {
      console.error(
        '[hitly email-change] Failed to send confirmation email:',
        error instanceof Error ? error.message : error,
      )
    })
  }
}

export function createSendEmailChangedNotice(send: MailFn) {
  return async ({ to }: { to: string }) => {
    void send(buildEmailChangedNotice({ to })).catch((error: unknown) => {
      console.error(
        '[hitly email-change] Failed to send email-changed notice:',
        error instanceof Error ? error.message : error,
      )
    })
  }
}

export type EmailChangeOutcome = { ok: true } | { ok: false; message: string }

/**
 * Posts the change request from the signed-in form. A lost session reads as
 * "sign in again"; a wrong current password reuses the password-change
 * wording. Whether the new address is already taken is never distinguished
 * in the reply.
 */
export async function submitEmailChange(
  currentPassword: string,
  newEmail: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailChangeOutcome> {
  try {
    const response = await fetchImpl(CHANGE_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newEmail }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, message: CHANGE_EMAIL_UNAUTHENTICATED_MESSAGE }
    if (response.status === 429) return { ok: false, message: CHANGE_EMAIL_THROTTLED_MESSAGE }
    if (response.status >= 500) return { ok: false, message: CHANGE_EMAIL_RETRY_MESSAGE }
    const data = (await response.json().catch(() => ({}))) as { code?: string }
    if (data.code === 'INVALID_PASSWORD') return { ok: false, message: CURRENT_PASSWORD_INCORRECT_MESSAGE }
    if (data.code === 'INVALID_EMAIL' || data.code === 'VALIDATION_ERROR') {
      return { ok: false, message: INVALID_EMAIL_MESSAGE }
    }
    return { ok: false, message: CHANGE_EMAIL_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitEmailChangeVerification(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailChangeOutcome> {
  try {
    const response = await fetchImpl(VERIFY_EMAIL_CHANGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    if (response.status >= 500) return { ok: false, message: CHANGE_EMAIL_RETRY_MESSAGE }
    return { ok: false, message: VERIFY_EMAIL_CHANGE_INVALID_MESSAGE }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}
