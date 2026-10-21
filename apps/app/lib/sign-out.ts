/**
 * Sign-out flow shared by the profile-menu button and tests.
 *
 * The client calls POST /api/session/sign-out (a route outside the better-auth
 * catch-all). That route best-effort revokes the session through the server
 * auth instance and ALWAYS expires the HttpOnly session cookies plus the
 * workspace cookie on its response, so the session is truly ended even when
 * revocation fails — the browser cannot clear HttpOnly cookies from JS.
 *
 * Whichever way the request ends — 200, 401, 415, any other non-ok status, or
 * a network error — we clear the client-readable session state exactly once
 * and hard-redirect to /login. We never retry, so sign-out can never trap the
 * user in an error state or a redirect loop.
 */

export const SIGN_OUT_ENDPOINT = '/api/session/sign-out'
export const LOGIN_PATH = '/login'

/**
 * Client-readable cookies we can clear from JS. The better-auth session
 * cookie is httpOnly and is cleared server-side only when the sign-out call
 * succeeds; a best-effort clear here covers the non-httpOnly names.
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
}

export async function performSignOut(hooks: SignOutHooks = {}): Promise<void> {
  const doFetch = hooks.fetchImpl ?? ((input, init) => fetch(input, init))
  const clearCookie = hooks.clearBrowserCookie ?? defaultClearCookie
  const navigate = hooks.navigate ?? ((url) => window.location.replace(url))
  const logError = hooks.logError ?? ((message, detail) => console.error(message, detail))

  try {
    const response = await doFetch(SIGN_OUT_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) {
      // A non-ok status (401 already-ended session, 415, 5xx) must not trap
      // the user in the app: fall through to cleanup + redirect.
      logError(`[hitly sign-out] Server returned error: ${response.status}`)
    }
  } catch (error) {
    logError('[hitly sign-out] Failed to sign out:', error)
  }

  for (const [name, secure] of CLIENT_COOKIES) {
    clearCookie(name, { secure: secure === true })
  }
  navigate(LOGIN_PATH)
}

function defaultClearCookie(name: string, opts: { secure?: boolean } = {}): void {
  const secure = opts.secure ? '; Secure' : ''
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
}
