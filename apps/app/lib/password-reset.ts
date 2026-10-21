/**
 * Password reset: shared constants, the email Better Auth sends, and the
 * client-side request helper used by the forgot-password form.
 *
 * Better Auth 1.6 serves the request at /request-password-reset (the older
 * /forget-password path is no longer mounted), and /reset-password expects
 * `newPassword` plus the `token` from the email link.
 */

export const AUTH_BASE_PATH = '/api/auth'
export const REQUEST_PASSWORD_RESET_ENDPOINT = `${AUTH_BASE_PATH}/request-password-reset`
export const RESET_PASSWORD_ENDPOINT = `${AUTH_BASE_PATH}/reset-password`
export const RESET_PASSWORD_PAGE = '/reset-password'

export const RESET_REQUESTED_MESSAGE = 'If that account exists, we have sent a reset link'
export const INVALID_EMAIL_MESSAGE = 'Enter a valid email address.'
export const RESET_REQUEST_NETWORK_MESSAGE = 'Could not reach HITLy. Check your connection and try again.'
export const RESET_LINK_INVALID_MESSAGE = 'This reset link is invalid or has expired. Request a new one.'
export const RESET_PASSWORD_FAILED_MESSAGE = 'Could not update the password. Request a new reset link and try again.'
export const PASSWORD_MISMATCH_MESSAGE = 'The passwords do not match.'
export const MIN_PASSWORD_LENGTH = 8

/** Link to the app's reset page carrying the one-time token. */
export function buildResetPageUrl(appUrl: string, token: string): string {
  const url = new URL(RESET_PASSWORD_PAGE, appUrl)
  url.searchParams.set('token', token)
  return url.toString()
}

export function buildResetEmail({ to, link }: { to: string; link: string }) {
  return {
    to,
    subject: 'HITLy: Reset your password',
    text: [
      'Someone asked to reset the password for your HITLy account.',
      '',
      'Open this link to choose a new password (it expires in one hour):',
      '',
      link,
      '',
      'If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  }
}

type MailFn = (message: { to: string; subject: string; text: string }) => Promise<unknown>

/**
 * Builds the `sendResetPassword` hook for Better Auth. The email links straight
 * to the app's reset page (not the API callback), so it works whether or not
 * the client passed a redirect URL. Sending is not awaited, so the response
 * time and body are the same whether or not the account exists.
 */
export function createSendResetPassword(appUrl: string, send: MailFn) {
  return async ({ user, token }: { user: { email: string }; url: string; token: string }) => {
    const message = buildResetEmail({ to: user.email, link: buildResetPageUrl(appUrl, token) })
    void send(message).catch((error: unknown) => {
      console.error('[hitly password-reset] Failed to send reset email:', error instanceof Error ? error.message : error)
    })
  }
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

export type ResetPasswordOutcome = { ok: true } | { ok: false; message: string }

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
    const data = (await response.json().catch(() => ({}))) as { code?: string }
    if (data.code === 'INVALID_TOKEN') return { ok: false, message: RESET_LINK_INVALID_MESSAGE }
    if (data.code === 'PASSWORD_TOO_SHORT') {
      return { ok: false, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }
    }
    if (data.code === 'PASSWORD_TOO_LONG') return { ok: false, message: 'That password is too long.' }
    return { ok: false, message: RESET_PASSWORD_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}
