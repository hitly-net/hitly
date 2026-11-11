/**
 * Password reset: shared constants and the client-side request helpers used
 * by the forgot-password form. The branded reset email itself (which renders
 * HTML) lives in lib/password-reset-emails.ts so client components never
 * import the mail renderer.
 *
 * Better Auth 1.6 serves the request at /request-password-reset (the older
 * /forget-password path is no longer mounted), and /reset-password expects
 * `newPassword` plus the `token` from the email link.
 */

export const AUTH_BASE_PATH = '/api/auth'
export const REQUEST_PASSWORD_RESET_ENDPOINT = `${AUTH_BASE_PATH}/request-password-reset`
export const RESET_PASSWORD_ENDPOINT = `${AUTH_BASE_PATH}/reset-password`
export const RESET_PASSWORD_PAGE = '/reset-password'
export const FORGOT_PASSWORD_PAGE = '/forgot-password'

export const RESET_REQUESTED_MESSAGE = 'If that account exists, we have sent a reset link'
export const INVALID_EMAIL_MESSAGE = 'Enter a valid email address.'
export const RESET_REQUEST_NETWORK_MESSAGE = 'Could not reach HITLy. Check your connection and try again.'
export const RESET_LINK_INVALID_MESSAGE = 'This reset link is invalid or has expired. Request a new one.'
export const RESET_PASSWORD_FAILED_MESSAGE = 'Could not update the password. Request a new reset link and try again.'
export const RESET_PASSWORD_RETRY_MESSAGE = 'Could not update the password right now. Try again in a moment.'
export const RESET_LINK_CHECK_UNAVAILABLE_MESSAGE = "We couldn't check this link right now."
export const PASSWORD_MISMATCH_MESSAGE = 'The passwords do not match.'
export const MIN_PASSWORD_LENGTH = 8

/** Link to the app's reset page carrying the one-time token. */
export function buildResetPageUrl(appUrl: string, token: string): string {
  const url = new URL(RESET_PASSWORD_PAGE, appUrl)
  url.searchParams.set('token', token)
  return url.toString()
}

export type MailFn = (message: { to: string; subject: string; text: string }) => Promise<unknown>

/**
 * Client message for a password policy rejection from Better Auth, or null
 * for other codes. One helper answers both the reset flow and the signed-in
 * change flow (lib/password-change.ts) so the strength wording lives in one
 * place, alongside MIN_PASSWORD_LENGTH - which also feeds Better Auth's
 * `minPasswordLength` (lib/auth-email-password.ts) and the forms'
 * `minLength` attributes.
 */
export function passwordPolicyMessage(code: string | undefined): string | null {
  if (code === 'PASSWORD_TOO_SHORT') return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (code === 'PASSWORD_TOO_LONG') return 'That password is too long.'
  return null
}

export type ResetRequestOutcome =
  | { kind: 'sent'; message: string }
  | { kind: 'invalid-email'; message: string }
  | { kind: 'network'; message: string }

/**
 * Posts a reset request. Every server answer except an email validation error
 * maps to the same message, so the page never reveals whether an account exists.
 */
export async function requestPasswordReset(
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResetRequestOutcome> {
  let response: Response
  try {
    response = await fetchImpl(REQUEST_PASSWORD_RESET_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), redirectTo: RESET_PASSWORD_PAGE }),
      credentials: 'include',
    })
  } catch {
    return { kind: 'network', message: RESET_REQUEST_NETWORK_MESSAGE }
  }
  if (response.status === 400) {
    const data = (await response.json().catch(() => ({}))) as { code?: string }
    if (data.code === 'VALIDATION_ERROR' || data.code === 'INVALID_EMAIL') {
      return { kind: 'invalid-email', message: INVALID_EMAIL_MESSAGE }
    }
  }
  if (!response.ok) {
    console.error(`[hitly password-reset] Reset request returned ${response.status}`)
  }
  return { kind: 'sent', message: RESET_REQUESTED_MESSAGE }
}

/**
 * `requestNewLink` is true when the token was rejected (used, expired, or
 * unknown) or the server refused the request for another reason a fresh link
 * may fix, so the form can offer "Request a new link". A server error (5xx)
 * asks the user to try again instead, since the link may still be fine.
 */
export type ResetPasswordOutcome = { ok: true } | { ok: false; message: string; requestNewLink: boolean }

export async function submitNewPassword(
  token: string,
  newPassword: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResetPasswordOutcome> {
  try {
    const response = await fetchImpl(RESET_PASSWORD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    if (response.status >= 500) return { ok: false, message: RESET_PASSWORD_RETRY_MESSAGE, requestNewLink: false }
    const data = (await response.json().catch(() => ({}))) as { code?: string }
    if (data.code === 'INVALID_TOKEN') return { ok: false, message: RESET_LINK_INVALID_MESSAGE, requestNewLink: true }
    const policy = passwordPolicyMessage(data.code)
    if (policy) return { ok: false, message: policy, requestNewLink: false }
    return { ok: false, message: RESET_PASSWORD_FAILED_MESSAGE, requestNewLink: true }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE, requestNewLink: false }
  }
}
