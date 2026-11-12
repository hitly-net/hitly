/**
 * After a successful sign-in, if the account has MFA enabled the Better Auth
 * session is held server-side and the client receives only a short-lived
 * challenge cookie. The half-auth cookie is not a session and cannot pass
 * getSession / requireApiSession / page guards. The second step is still
 * POST /api/session/mfa/verify, which finishes on /login/mfa.
 *
 * Email/password (`POST …/sign-in/email`) is the reference path. Its checks,
 * logs, stash row, and `{ mfaRequired: true }` response are unchanged.
 *
 * Other session-minting sign-ins use the same stash, challenge cookie,
 * lockout counters, and recovery codes. A UV passkey sign-in does not: user
 * verification is required, and a verified passkey satisfies MFA on its own
 * (ruling, 11 Nov 2026), so `POST …/passkey/verify-authentication` is not held.
 *
 * Social providers are not mounted. `GET`/`POST /callback/:id` and
 * `GET /oauth2/callback/:providerId` are the seam a future OAuth callback
 * goes through. Magic-link verify and email OTP sign-in are pre-wired the
 * same way so enabling those plugins cannot skip the hold.
 *
 * Fail closed: if MFA status cannot be read, or the wrapping key is missing
 * while MFA is on, the session is revoked and no session cookie is forwarded.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { sessions, userMfaChallenges } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import {
  generateMfaChallengeToken,
  hashMfaChallengeToken,
  isMfaEnabled,
  mfaJson,
  type MfaRouteDeps,
} from './mfa-route'
import { MFA_CHALLENGE_COOKIE, MFA_CHALLENGE_TTL_MS, MFA_VERIFY_PAGE } from './mfa'
import { encryptUtf8, mfaEncryptionKeyProblem, MFA_ENCRYPTION_KEY_ENV, resolveMfaEncryptionKey } from './mfa-crypto'
import { newId } from './ids'

export type SessionMintAction = 'hold' | 'uv-satisfies-mfa' | 'not-sign-in'

export type SessionRoutePolicy = {
  action: SessionMintAction
  /** False when the route exists only after a plugin this app does not mount. */
  mounted: boolean
  /** How MFA applies. Shown in the route audit. */
  mfa: string
}

/**
 * Every Better Auth route mounted on the app auth instance, plus sign-in
 * routes that mint a session only after a plugin we do not mount yet.
 * Keys are `METHOD /path` as `getEndpoints` reports them (`/api/auth` stripped).
 * A new mounted route that is missing here fails the route-coverage test.
 */
export const SESSION_ROUTE_POLICY = {
  'GET /account-info': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Reads linked-account metadata.',
  },
  'GET /callback/:id': {
    action: 'hold',
    mounted: true,
    mfa: 'Enforced when user_mfa.enabled and the callback sets a session cookie. OAuth seam; no provider is mounted.',
  },
  'POST /callback/:id': {
    action: 'hold',
    mounted: true,
    mfa: 'Same seam. Better Auth 1.6.27 POST only redirects to GET and does not set a session cookie, so the hold does not rewrite it.',
  },
  'GET /delete-user/callback': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Deletes the user.',
  },
  'GET /error': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Error page.',
  },
  'GET /get-session': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a new sign-in. Reads or refreshes an existing session; MFA was enforced when that session was minted.',
  },
  'POST /get-session': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a new sign-in. Same session refresh as GET /get-session.',
  },
  'GET /list-accounts': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in.',
  },
  'GET /list-sessions': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in.',
  },
  'GET /ok': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in.',
  },
  'GET /passkey/generate-authenticate-options': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. WebAuthn challenge only.',
  },
  'GET /passkey/generate-register-options': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Plugin management path; the catch-all returns 404 before the plugin.',
  },
  'GET /passkey/list-user-passkeys': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Plugin management path; the catch-all returns 404 before the plugin.',
  },
  'GET /reset-password/:token': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Looks up a reset token and redirects.',
  },
  'GET /verify-email': {
    action: 'hold',
    mounted: true,
    mfa: 'Enforced only when this route mints a session (autoSignInAfterVerification). A reply with no session cookie is forwarded unchanged. The verify-email page and signup mail are not part of this hold.',
  },
  'POST (server-only setPassword)': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not an HTTP route. Server-only helper; it does not mint a session.',
  },
  'POST /change-email': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Better Auth email change is unused. HITLy email change stays on /api/session/change-email and is not wrapped.',
  },
  'POST /change-password': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Signed-in password rotation. HITLy password change stays on /api/session/change-password and is not wrapped.',
  },
  'POST /delete-user': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Deletes the user and clears the session cookie.',
  },
  'POST /get-access-token': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Returns an IdP access token for an existing session.',
  },
  'POST /link-social': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Starts an OAuth link. The callback is the session mint and is held.',
  },
  'POST /passkey/delete-passkey': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Plugin management path; the catch-all returns 404 before the plugin.',
  },
  'POST /passkey/update-passkey': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Plugin management path; the catch-all returns 404 before the plugin.',
  },
  'POST /passkey/verify-authentication': {
    action: 'uv-satisfies-mfa',
    mounted: true,
    mfa: 'MFA satisfied by UV. A verified passkey mints a full session even when TOTP is enrolled. An assertion without UV is rejected before this route runs.',
  },
  'POST /passkey/verify-registration': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Plugin management path; the catch-all returns 404. Registration is /api/session/passkey/register.',
  },
  'POST /refresh-token': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Refreshes an IdP access token, not a HITLy session.',
  },
  'POST /request-password-reset': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Sends the reset mail.',
  },
  'POST /reset-password': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Sets a new password and revokes sessions. It does not sign in.',
  },
  'POST /revoke-other-sessions': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Revokes other sessions.',
  },
  'POST /revoke-session': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Revokes one session.',
  },
  'POST /revoke-sessions': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Revokes sessions.',
  },
  'POST /send-verification-email': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Sends mail.',
  },
  'POST /sign-in/email': {
    action: 'hold',
    mounted: true,
    mfa: 'Enforced when user_mfa.enabled. Reference password path.',
  },
  'POST /sign-in/social': {
    action: 'hold',
    mounted: true,
    mfa: 'Enforced when the idToken branch mints a session. The authorize-URL branch sets no session cookie and is forwarded unchanged. No provider is mounted.',
  },
  'POST /sign-out': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Ends the session.',
  },
  'POST /sign-up/email': {
    action: 'hold',
    mounted: true,
    mfa: 'Enforced when user_mfa.enabled. A new account has no MFA row, so the session is forwarded unchanged.',
  },
  'POST /unlink-account': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in.',
  },
  'POST /update-session': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a new sign-in. Updates the current session and re-sets its cookie.',
  },
  'POST /update-user': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a new sign-in. Profile update re-sets the current session cookie.',
  },
  'POST /verify-password': {
    action: 'not-sign-in',
    mounted: true,
    mfa: 'Not a sign-in. Checks the current session password.',
  },
  'GET /magic-link/verify': {
    action: 'hold',
    mounted: false,
    mfa: 'Not mounted. Pre-wired: enabling magic link holds verify, which is the route that mints the session.',
  },
  'POST /sign-in/email-otp': {
    action: 'hold',
    mounted: false,
    mfa: 'Not mounted. Pre-wired: enabling email OTP holds this sign-in.',
  },
  'POST /email-otp/verify-email': {
    action: 'hold',
    mounted: false,
    mfa: 'Not mounted. Pre-wired: this email OTP route can mint a session.',
  },
  'GET /oauth2/callback/:providerId': {
    action: 'hold',
    mounted: false,
    mfa: 'Not mounted. Pre-wired generic-OAuth callback seam, same hold as /callback/:id.',
  },
} as const satisfies Record<string, SessionRoutePolicy>

export type SessionRouteKey = keyof typeof SESSION_ROUTE_POLICY

/** `METHOD /path` for one mounted auth.api endpoint. `path` is omitted for server-only helpers. */
export function mountedEndpointKey(name: string, path: string | undefined, method: string): string {
  if (!path) return `${method} (server-only ${name})`
  return `${method} ${path}`
}

export function isEmailPasswordSignIn(request: Request): boolean {
  try {
    const pathname = new URL(request.url).pathname
    return request.method === 'POST' && pathname.endsWith('/sign-in/email')
  } catch {
    return false
  }
}

/** Route key for a catch-all request, or null when the URL is not under /api/auth. */
export function sessionRouteKeyFromRequest(request: Request): SessionRouteKey | string | null {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return null
  }
  const lower = pathname.toLowerCase()
  const marker = '/api/auth'
  const at = lower.indexOf(marker)
  if (at === -1) return null
  let rest = lower.slice(at + marker.length)
  if (!rest.startsWith('/')) rest = `/${rest}`
  rest = rest.replace(/\/+$/, '') || '/'
  const method = request.method.toUpperCase()
  if (/^\/callback\/[^/]+$/.test(rest)) return `${method} /callback/:id`
  if (/^\/oauth2\/callback\/[^/]+$/.test(rest)) return `${method} /oauth2/callback/:providerId`
  if (/^\/reset-password\/[^/]+$/.test(rest)) return `${method} /reset-password/:token`
  return `${method} ${rest}`
}

export function sessionRoutePolicyFor(request: Request): SessionRoutePolicy | null {
  const key = sessionRouteKeyFromRequest(request)
  if (!key || !(key in SESSION_ROUTE_POLICY)) return null
  return SESSION_ROUTE_POLICY[key as SessionRouteKey]
}

/**
 * True when this request is a session-minting sign-in the hold must consider.
 * Password uses the reference predicate. Passkey verify is deliberately false.
 */
export function isSignInHeld(request: Request): boolean {
  if (isEmailPasswordSignIn(request)) return true
  return isExtendedHold(request)
}

function isExtendedHold(request: Request): boolean {
  if (isEmailPasswordSignIn(request)) return false
  const key = sessionRouteKeyFromRequest(request)
  // A trailing-slash password URL normalises to the reference key but does not
  // match isEmailPasswordSignIn. Leave it unheld so that URL stays as it was.
  if (!key || key === 'POST /sign-in/email') return false
  return SESSION_ROUTE_POLICY[key as SessionRouteKey]?.action === 'hold'
}

const SESSION_TOKEN_COOKIE = /^(?:__Secure-)?better-auth\.session_token=(.*)$/

export function hasFreshSessionCookie(setCookies: string[]): boolean {
  return setCookies.some((cookie) => {
    const pair = cookie.split(';')[0]?.trim() ?? ''
    const match = SESSION_TOKEN_COOKIE.exec(pair)
    if (!match?.[1]) return false
    return !/max-age=0/i.test(cookie)
  })
}

function readSetCookies(response: Response): string[] {
  return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
}

function replayJson(response: Response, body: unknown): NextResponse {
  const next = NextResponse.json(body, { status: response.status })
  for (const cookie of response.headers.getSetCookie()) next.headers.append('set-cookie', cookie)
  const cache = response.headers.get('cache-control')
  if (cache) next.headers.set('cache-control', cache)
  next.headers.set('referrer-policy', 'no-referrer')
  return next
}

async function revokeCookies(setCookies: string[]) {
  if (!auth) return
  const cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ')
  if (!cookie) return
  try {
    await auth.api.signOut({ headers: new Headers({ cookie }) })
  } catch {
    // The held session is dropped below by id when we have one.
  }
}

function setChallengeCookie(held: NextResponse, token: string) {
  const secure = process.env.NODE_ENV === 'production'
  held.cookies.set(MFA_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(MFA_CHALLENGE_TTL_MS / 1000),
    secure,
  })
}

function challengeJson(token: string): NextResponse {
  const held = mfaJson({ mfaRequired: true })
  setChallengeCookie(held, token)
  return held
}

function challengeRedirect(token: string): NextResponse | null {
  const base = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
  let url: URL
  try {
    url = new URL(MFA_VERIFY_PAGE, base)
  } catch {
    return null
  }
  const held = NextResponse.redirect(url, 302)
  held.headers.set('cache-control', 'no-store')
  held.headers.set('referrer-policy', 'no-referrer')
  setChallengeCookie(held, token)
  return held
}

async function holdEnabledSignIn(
  deps: MfaRouteDeps,
  setCookies: string[],
  userId: string,
  present: 'json' | 'redirect',
): Promise<Response> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now

  const database = deps.database ?? db
  if (!database) {
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  if (mfaEncryptionKeyProblem(process.env[MFA_ENCRYPTION_KEY_ENV]) && !deps.encryptionKey) {
    log('[hitly mfa] Encryption key is not configured; sign-in with MFA refused')
    await revokeCookies(setCookies)
    return mfaJson({ error: 'mfa_unavailable' }, 503)
  }

  const cookieHeader = setCookies.map((entry) => entry.split(';')[0]).join('; ')
  if (!auth) {
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  let sessionId: string | null = null
  try {
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) })
    sessionId = session?.session?.id ?? null
  } catch (error) {
    log(`[hitly mfa] Could not read the new session: ${error instanceof Error ? error.name : 'error'}`)
  }
  if (!sessionId) {
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  const key = deps.encryptionKey ?? resolveMfaEncryptionKey()
  const token = generateMfaChallengeToken()

  try {
    const previous = await database.select().from(userMfaChallenges).where(eq(userMfaChallenges.userId, userId))
    for (const row of previous) {
      await database.delete(sessions).where(eq(sessions.id, row.sessionId))
    }
    await database.delete(userMfaChallenges).where(eq(userMfaChallenges.userId, userId))
    await database.insert(userMfaChallenges).values({
      id: newId('mfc').slice(0, 36),
      userId,
      tokenHash: hashMfaChallengeToken(token),
      sessionId,
      cookiesCiphertext: encryptUtf8(JSON.stringify({ setCookies, sessionId }), key),
      expiresAt: new Date(now() + MFA_CHALLENGE_TTL_MS),
    })
  } catch (error) {
    log(`[hitly mfa] Could not hold the sign-in for MFA: ${error instanceof Error ? error.name : 'error'}`)
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  if (present === 'redirect') {
    const redirected = challengeRedirect(token)
    if (redirected) return redirected
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }
  return challengeJson(token)
}

async function jsonUserId(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { user?: { id?: string } } | null
    return typeof data?.user?.id === 'string' ? data.user.id : ''
  } catch {
    return ''
  }
}

async function readSessionUser(setCookies: string[], log: (line: string) => void): Promise<string> {
  if (!auth) return ''
  const cookieHeader = setCookies.map((entry) => entry.split(';')[0]).join('; ')
  try {
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) })
    return session?.user?.id ?? ''
  } catch (error) {
    log(`[hitly mfa] Could not read the new session: ${error instanceof Error ? error.name : 'error'}`)
    return ''
  }
}

async function holdExtendedSignInIfMfa(response: Response, deps: MfaRouteDeps): Promise<Response> {
  if (response.status < 200 || response.status >= 400) return response
  const setCookies = readSetCookies(response)
  if (!hasFreshSessionCookie(setCookies)) return response

  const log = deps.log ?? ((line: string) => console.warn(line))
  const present: 'json' | 'redirect' = response.status >= 300 ? 'redirect' : 'json'
  let userId = await jsonUserId(response)
  if (!userId) {
    userId = await readSessionUser(setCookies, log)
    if (!userId) {
      await revokeCookies(setCookies)
      return mfaJson({ error: 'sign_in_failed' }, 500)
    }
  }

  let enabled: boolean
  try {
    enabled = await isMfaEnabled(userId, deps)
  } catch (error) {
    log(`[hitly mfa] Could not read MFA status at sign-in: ${error instanceof Error ? error.name : 'error'}`)
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }
  if (!enabled) return response
  const sessionUser = await readSessionUser(setCookies, log)
  if (sessionUser !== userId) {
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }
  return holdEnabledSignIn(deps, setCookies, userId, present)
}

export async function holdPasswordSignInIfMfa(
  request: Request,
  response: Response,
  deps: MfaRouteDeps = {},
): Promise<Response> {
  if (!isEmailPasswordSignIn(request)) {
    if (!isExtendedHold(request)) return response
    return holdExtendedSignInIfMfa(response, deps)
  }
  if (response.status !== 200) return response

  const log = deps.log ?? ((line: string) => console.warn(line))
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const data = (await response.json().catch(() => null)) as { user?: { id?: string } } | null
  const userId = typeof data?.user?.id === 'string' ? data.user.id : ''
  if (!userId) return replayJson(response, data ?? {})

  let enabled: boolean
  try {
    enabled = await isMfaEnabled(userId, deps)
  } catch (error) {
    log(`[hitly mfa] Could not read MFA status at sign-in: ${error instanceof Error ? error.name : 'error'}`)
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }
  if (!enabled) return replayJson(response, data)

  return holdEnabledSignIn(deps, setCookies, userId, 'json')
}
