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
 * - Network failure, a ~10 s timeout (AbortController), or any other error
 *   response: do NOT redirect. The user is still signed in, so the button
 *   re-enables and shows the inline SIGN_OUT_FAILURE_MESSAGE instead.
 */

export const SIGN_OUT_ENDPOINT = '/api/session/sign-out'
export const LOGIN_PATH = '/login'
export const SIGN_OUT_TIMEOUT_MS = 10_000

export const SIGN_OUT_FAILURE_MESSAGE = 'Sign-out failed, you are still signed in. Try again.'

export type SignOutOutcome = 'redirected' | 'failed'

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
    // 415, 5xx or any other error response: the session may still be live.
    logError(`[hitly sign-out] Server returned error: ${response.status}`)
    return 'failed'
  } catch (error) {
    // Network failure or the timeout above.
    logError('[hitly sign-out] Failed to sign out:', error)
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}

function defaultClearCookie(name: string, opts: { secure?: boolean } = {}): void {
  const secure = opts.secure ? '; Secure' : ''
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
}
