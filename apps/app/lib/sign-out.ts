/**
 * Sign-out flow shared by the profile-menu button and tests.
 *
 * The client calls POST /api/session/sign-out (a route outside the better-auth
 * catch-all). That route revokes the session server-side and expires the
 * session cookies itself via Set-Cookie response headers: JavaScript cannot
 * clear the HttpOnly session cookie from the browser, so the server-side
 * expiry is what ends the session.
 *
 * Outcome handling (one request per click, never a retry loop):
 * - 2xx success, or 401 (the session is already gone): clear local state and
 *   hard-redirect to /login.
 * - HTTP 500 whose JSON body carries error 'sign_out_failed': the sign-out
 *   route expired the session cookies on its response, so this device is
 *   signed out, but the server-side session could not be ended. No redirect;
 *   the inline message says exactly that. Any other 500 is treated like any
 *   other error below.
 * - Network failure, a ~10 s timeout (AbortController), or any other error
 *   response: nothing was cleared, the user is still signed in, so the button
 *   re-enables and shows SIGN_OUT_FAILURE_MESSAGE instead.
 */

export const SIGN_OUT_ENDPOINT = '/api/session/sign-out'
export const LOGIN_PATH = '/login'
export const SIGN_OUT_TIMEOUT_MS = 10_000

export const SIGN_OUT_FAILURE_MESSAGE = 'Sign-out failed, you are still signed in. Try again.'

/**
 * Shown when the sign-out route answered 500 with error 'sign_out_failed':
 * its response expired the session cookies, so the device is signed out even
 * though the server-side session outlived the attempt.
 */
export const SIGN_OUT_SERVER_FAILURE_MESSAGE =
  'Signed out on this device, but we could not end your session on the server. Try again.'

/** Error code the sign-out route returns when the server session outlived the attempt. */
export const SIGN_OUT_SERVER_ERROR_CODE = 'sign_out_failed'

export type SignOutOutcome = 'redirected' | 'failed' | 'failed_server'

/** Maps a sign-out outcome to the message shown inline under the button. */
export function signOutFailureMessage(outcome: Exclude<SignOutOutcome, 'redirected'>): string {
  return outcome === 'failed_server' ? SIGN_OUT_SERVER_FAILURE_MESSAGE : SIGN_OUT_FAILURE_MESSAGE
}

/**
 * Best-effort JS clears. The better-auth session cookie is HttpOnly and can
 * only be expired by the server route's Set-Cookie header (done on every
 * response, success or error); these entries matter only when the cookies are
 * configured without httpOnly, plus the always-JS-readable workspace cookie.
 */
const CLIENT_COOKIES: ReadonlyArray<readonly [name: string, secure?: boolean]> = [
  ['hitly-workspace-id', false],
  ['better-auth.session_token', false],
  ['__Secure-better-auth.session_token', true],
]

export interface SignOutHooks {
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  clearBrowserCookie?: (name: string, opts?: { secure?: boolean }) => void
  navigate?: (url: string) => void
  logError?: (message: string, detail?: unknown) => void
  timeoutMs?: number
}

export async function performSignOut(hooks: SignOutHooks = {}): Promise<SignOutOutcome> {
  const doFetch = hooks.fetchImpl ?? ((input, init) => fetch(input, init))
  const clearCookie = hooks.clearBrowserCookie ?? defaultClearCookie
  const navigate = hooks.navigate ?? ((url) => window.location.replace(url))
  const logError = hooks.logError ?? ((message, detail) => (detail === undefined ? console.error(message) : console.error(message, detail)))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), hooks.timeoutMs ?? SIGN_OUT_TIMEOUT_MS)

  try {
    const response = await doFetch(SIGN_OUT_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    if (response.ok || response.status === 401) {
      // Signed out (or already signed out): clear local state and leave.
      for (const [name, secure] of CLIENT_COOKIES) {
        clearCookie(name, { secure: secure === true })
      }
      navigate(LOGIN_PATH)
      return 'redirected'
    }
    // 415 or any other error response: nothing was cleared; the user may
    // still be signed in. Only the sign-out route's own failure (500 with
    // error 'sign_out_failed') means its response expired the cookies, so
    // this device is signed out even if the server session outlived the
    // attempt. Any other 500 (for example from the framework) is a plain
    // failure.
    logError(`[hitly sign-out] Server returned error: ${response.status}`)
    if (response.status === 500 && (await readErrorCode(response)) === SIGN_OUT_SERVER_ERROR_CODE) {
      return 'failed_server'
    }
    return 'failed'
  } catch (error) {
    // Network failure or the timeout above.
    logError('[hitly sign-out] Failed to sign out:', error)
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}

/** Reads the `error` field of a JSON error body; null when absent or unreadable. */
async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error
    }
  } catch {
    // Not JSON (for example an HTML error page): no error code.
  }
  return null
}

function defaultClearCookie(name: string, opts: { secure?: boolean } = {}): void {
  const secure = opts.secure ? '; Secure' : ''
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
}
