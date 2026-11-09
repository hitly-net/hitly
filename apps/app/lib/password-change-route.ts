/**
 * The server half of the signed-in password change: the handler behind
 * POST /api/session/change-password (lib/password-change.ts holds the
 * client-safe helpers the forms import). Server-only imports (auth, the
 * database, the mailer) stay out of the client bundle by living here.
 *
 * In-process Better Auth calls skip its own request limiter (same reason the
 * reset link check needs its own, see lib/reset-check-limit.ts), so attempts
 * are throttled per client with the shared limiter (lib/change-password-limit.ts).
 *
 * Nothing here logs a password: failures are logged as fixed lines only.
 */

import { NextResponse } from 'next/server'
import { auth } from './auth'
import { CHANGE_PASSWORD_LIMITED_LOG, changePasswordAttemptLimiter } from './change-password-limit'
import { createSendPasswordChangedNotification } from './password-change'
import { sendMail } from './mail'
import { MIN_PASSWORD_LENGTH } from './password-reset'
import { resetCheckClientKey } from './reset-check-limit'

export type ChangePasswordSessionUser = { id: string; email: string }

export interface ChangePasswordRouteDeps {
  /** The signed-in user, or null when the request carries no valid session. */
  getSessionUser?: (headers: Headers) => Promise<ChangePasswordSessionUser | null>
  /** Runs the change through Better Auth; must honour revokeOtherSessions. */
  changePassword?: (headers: Headers, body: { currentPassword: string; newPassword: string }) => Promise<Response>
  /** The per-client limiter key (client address, or the shared bucket). */
  clientKey?: (headers: Headers) => string
  /** Consumes one attempt from the client's budget; false when it is spent. */
  allow?: (key: string) => boolean
  /** Sends the password-changed notification email. */
  notify?: (user: { email: string }) => Promise<void>
  log?: (line: string) => void
}

function json(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status })
  response.headers.set('cache-control', 'no-store')
  response.headers.set('referrer-policy', 'no-referrer')
  return response
}

type ChangePasswordRequest = { headers: Headers; json: () => Promise<unknown> }

/**
 * Handler for POST /api/session/change-password.
 *
 * 1. no session -> 401, the change is never attempted;
 * 2. the client's attempt budget (lib/change-password-limit.ts) must not be
 *    spent, else 429 without checking the password;
 * 3. the change runs through Better Auth with revokeOtherSessions: a wrong
 *    current password answers the INVALID_PASSWORD code and changes nothing,
 *    success answers { ok: true } and forwards the rotated session cookie
 *    (other sessions are revoked; this device continues);
 * 4. on success the password-changed email goes out through the app's mail
 *    path, fire-and-forget, carrying no secret.
 *
 * The request body must carry both passwords as non-empty strings; anything
 * else is a 400 and never reaches Better Auth.
 */
export async function handlePasswordChange(
  request: ChangePasswordRequest,
  deps: ChangePasswordRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const authInstance = auth
  const getSessionUser =
    deps.getSessionUser ??
    (async (headers: Headers) => {
      if (!authInstance) return null
      const session = await authInstance.api.getSession({ headers })
      return session?.user ? { id: session.user.id, email: session.user.email } : null
    })
  const changePassword =
    deps.changePassword ??
    ((headers: Headers, body: { currentPassword: string; newPassword: string }) => {
      if (!authInstance) return Promise.resolve(new Response('{}', { status: 503 }))
      return authInstance.api.changePassword({
        headers,
        body: { ...body, revokeOtherSessions: true },
        asResponse: true,
      }) as unknown as Promise<Response>
    })
  const allow = deps.allow ?? changePasswordAttemptLimiter
  const clientKey = deps.clientKey ?? resetCheckClientKey
  const notify = deps.notify ?? createSendPasswordChangedNotification(sendMail)

  let user: ChangePasswordSessionUser | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    // Database errors can carry query parameters, so log a fixed line only.
    log(`[hitly password-change] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'change_password_failed' }, 500)
  }
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
  if (!currentPassword || !newPassword) {
    return json({ code: 'MISSING_FIELDS', minLength: MIN_PASSWORD_LENGTH }, 400)
  }

  if (!allow(clientKey(request.headers))) {
    log(CHANGE_PASSWORD_LIMITED_LOG)
    return json({ error: 'too_many_attempts' }, 429)
  }

  let result: Response
  try {
    result = await changePassword(request.headers, { currentPassword, newPassword })
  } catch {
    log('[hitly password-change] Password change failed with an unexpected error')
    return json({ error: 'change_password_failed' }, 500)
  }

  const setCookies =
    typeof result.headers.getSetCookie === 'function' ? result.headers.getSetCookie() : []
  let response: NextResponse
  if (result.status === 200) {
    response = json({ ok: true })
    void notify({ email: user.email }).catch(() => {
      log('[hitly password-change] Could not queue the password-changed email')
    })
  } else if (result.status >= 500) {
    log('[hitly password-change] Password change failed with a server error')
    response = json({ error: 'change_password_failed' }, 500)
  } else {
    const data = (await result.json().catch(() => ({}))) as { code?: string }
    response = json({ code: data.code ?? 'INVALID_REQUEST' }, result.status)
  }
  // Success rotates the current session (other sessions were revoked): the
  // browser must receive the new cookie to stay signed in.
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
  return response
}
