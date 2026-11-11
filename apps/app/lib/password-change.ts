/**
 * Signed-in password change (client-safe half): the endpoint constant, the
 * fixed messages, and the client submit helper used by the security page's
 * form. The branded password-changed notification lives in
 * lib/password-change-emails.ts, and the route handler that touches auth,
 * the database and the mailer lives in lib/password-change-route.ts, so
 * client components import only this file (same split as the reset flow,
 * whose client module stays free of server imports).
 *
 * The change itself runs through Better Auth's /change-password endpoint.
 * Better Auth verifies the current password (a wrong one answers
 * INVALID_PASSWORD and changes nothing), enforces the same password policy
 * as reset (both flows read the emailAndPassword settings in
 * lib/auth-email-password.ts and the shared messages in
 * passwordPolicyMessage), and with revokeOtherSessions revokes every other
 * session of the account while the current device continues on a freshly
 * rotated session cookie.
 */

import {
  RESET_REQUEST_NETWORK_MESSAGE,
  passwordPolicyMessage,
} from './password-reset'

export const CHANGE_PASSWORD_ENDPOINT = '/api/session/change-password'

export const CURRENT_PASSWORD_INCORRECT_MESSAGE = 'Your current password is incorrect.'
export const CHANGE_PASSWORD_UNAUTHENTICATED_MESSAGE = 'Your session has ended. Sign in again to change your password.'
export const CHANGE_PASSWORD_THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'
export const CHANGE_PASSWORD_FAILED_MESSAGE = 'Could not change the password. Check the details and try again.'
export const CHANGE_PASSWORD_RETRY_MESSAGE = 'Could not change the password right now. Try again in a moment.'
export const CHANGE_PASSWORD_SUCCEEDED_MESSAGE = 'Your password has been updated.'

export type PasswordChangeOutcome = { ok: true } | { ok: false; message: string }

/**
 * Posts the change from the signed-in form. The route is session-required,
 * so a lost session reads as "sign in again"; codes map through the shared
 * passwordPolicyMessage so the wording matches the reset form.
 */
export async function submitPasswordChange(
  currentPassword: string,
  newPassword: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasswordChangeOutcome> {
  try {
    const response = await fetchImpl(CHANGE_PASSWORD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, message: CHANGE_PASSWORD_UNAUTHENTICATED_MESSAGE }
    if (response.status === 429) return { ok: false, message: CHANGE_PASSWORD_THROTTLED_MESSAGE }
    if (response.status >= 500) return { ok: false, message: CHANGE_PASSWORD_RETRY_MESSAGE }
    const data = (await response.json().catch(() => ({}))) as { code?: string }
    if (data.code === 'INVALID_PASSWORD') return { ok: false, message: CURRENT_PASSWORD_INCORRECT_MESSAGE }
    const policy = passwordPolicyMessage(data.code)
    if (policy) return { ok: false, message: policy }
    return { ok: false, message: CHANGE_PASSWORD_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}
