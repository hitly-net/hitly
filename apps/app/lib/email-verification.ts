/**
 * Public sign-up email verification (client-safe half): endpoint constants,
 * fixed messages, and the submit helpers used by the confirm page and the
 * settings notice. The branded email lives in lib/email-verification-emails.ts,
 * and the handlers that touch auth, the database and the mailer live in
 * lib/email-verification-route.ts, so client components import only this file.
 *
 * The account stays unverified until the link is confirmed. The token exists
 * only in the email; this module never logs it.
 */

import { RESET_REQUEST_NETWORK_MESSAGE } from './password-reset'

export const VERIFY_EMAIL_ENDPOINT = '/api/session/verify-email'
export const RESEND_EMAIL_VERIFICATION_ENDPOINT = '/api/session/resend-email-verification'
export const VERIFY_EMAIL_PAGE = '/verify-email'

export const EMAIL_VERIFICATION_TTL_HOURS = 24
export const EMAIL_VERIFICATION_TTL_MS = EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000

export const EMAIL_VERIFIED_EVENT = 'email_verified'

export const VERIFY_EMAIL_INVALID_MESSAGE = 'This verification link is invalid or has expired.'
export const EMAIL_VERIFIED_MESSAGE = 'Your email address is verified.'
export const RESEND_VERIFICATION_SUCCEEDED_MESSAGE =
  'If this account still needs verification, a new link is on its way.'
export const RESEND_VERIFICATION_THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'
export const RESEND_VERIFICATION_UNAUTHENTICATED_MESSAGE =
  'Your session has ended. Sign in again to resend the verification email.'
export const RESEND_VERIFICATION_RETRY_MESSAGE =
  'Could not resend the verification email right now. Try again in a moment.'

/** Link to the confirm page carrying the one-time token. */
export function buildEmailVerificationPageUrl(appUrl: string, token: string): string {
  const url = new URL(VERIFY_EMAIL_PAGE, appUrl)
  url.searchParams.set('token', token)
  return url.toString()
}

export type EmailVerificationOutcome = { ok: true } | { ok: false; message: string }

/**
 * Confirms the token from the emailed link. Expired, used and unknown tokens
 * all surface as the same invalid-link message.
 */
export async function submitEmailVerification(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailVerificationOutcome> {
  try {
    const response = await fetchImpl(VERIFY_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    if (response.status >= 500) return { ok: false, message: RESEND_VERIFICATION_RETRY_MESSAGE }
    return { ok: false, message: VERIFY_EMAIL_INVALID_MESSAGE }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

/**
 * Signed-in resend. The server answer does not say whether a mail was sent,
 * so the success copy stays the same for an already-verified account.
 */
export async function submitResendEmailVerification(
  fetchImpl: typeof fetch = fetch,
): Promise<EmailVerificationOutcome> {
  try {
    const response = await fetchImpl(RESEND_EMAIL_VERIFICATION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, message: RESEND_VERIFICATION_UNAUTHENTICATED_MESSAGE }
    if (response.status === 429) return { ok: false, message: RESEND_VERIFICATION_THROTTLED_MESSAGE }
    return { ok: false, message: RESEND_VERIFICATION_RETRY_MESSAGE }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}
