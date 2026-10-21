import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { WORKSPACE_COOKIE } from '@/lib/context'

/**
 * Server-side sign-out.
 *
 * The browser cannot clear the HttpOnly session cookie from JavaScript, so
 * this route expires every session cookie on its response — always, including
 * on 5xx — and verifies through the server auth instance that the session was
 * really deleted before reporting success:
 *
 * 0. the request must come from the app's own origin (the configured app URL)
 *    and carry a JSON content type; anything else is rejected up-front,
 * 1. best-effort revoke via the existing auth instance (failures are logged,
 *    never fatal — the verification below decides),
 * 2. confirm the session no longer exists via getSession on the request
 *    headers. No session at all (already signed out) counts as success and
 *    returns 200 { ok: true }; a live session after revoke, or one that
 *    cannot be verified, returns 500 { error: 'sign_out_failed' } and never
 *    reports success,
 * 3. both better-auth session cookie variants (plain + __Secure-) and the
 *    workspace cookie are expired on the response either way.
 */

const APP_URL = () => (process.env.BETTER_AUTH_URL ?? 'http://localhost:3001').replace(/\/+$/, '')

/** True for application/json with an optional charset (and no other type). */
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false
  const [type] = contentType.split(';')
  return type.trim().toLowerCase() === 'application/json'
}

/**
 * Same-origin check for the sign-out route: the Origin header must match the
 * app's configured origin exactly. A missing or foreign Origin is rejected —
 * the sign-out is a state-changing request from the web client, which always
 * sends it.
 */
export function isSameOrigin(origin: string | null): boolean {
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(APP_URL()).origin
  } catch {
    return false
  }
}

const SESSION_COOKIES: ReadonlyArray<{ name: string; httpOnly?: boolean; secure?: boolean }> = [
  { name: 'better-auth.session_token', httpOnly: true },
  { name: '__Secure-better-auth.session_token', httpOnly: true, secure: true },
  { name: WORKSPACE_COOKIE },
]

function expireCookie(response: NextResponse, cookie: { name: string; httpOnly?: boolean; secure?: boolean }) {
  response.cookies.set(cookie.name, '', {
    path: '/',
    maxAge: 0,
    expires: new Date(0),
    sameSite: 'lax',
    httpOnly: cookie.httpOnly === true,
    ...(cookie.secure ? { secure: true } : {}),
  })
}

export interface SignOutRouteDeps {
  /** Resolves to the current session (truthy) or null when none exists. */
  getSession?: (headers: Headers) => Promise<unknown>
  revoke?: (headers: Headers) => Promise<unknown>
}

export async function handleSignOut(
  request: { headers: Headers },
  deps: SignOutRouteDeps = {},
): Promise<NextResponse> {
  const authInstance = auth
  const getSession =
    deps.getSession ??
    ((headers) => (authInstance ? authInstance.api.getSession({ headers }) : Promise.resolve(null)))
  const revoke = deps.revoke ?? ((headers) => (authInstance ? authInstance.api.signOut({ headers }) : undefined))

  try {
    await revoke(request.headers)
  } catch (error) {
    // Revocation failed or threw (e.g. 401 for an already-ended session);
    // whether the session still exists is decided by the check below.
    console.error('[hitly sign-out] Session revocation failed:', error)
  }

  let deleted: boolean
  try {
    deleted = (await getSession(request.headers)) === null
  } catch (error) {
    console.error('[hitly sign-out] Could not confirm the session was deleted:', error)
    deleted = false
  }

  const response = deleted
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'sign_out_failed' }, { status: 500 })
  for (const cookie of SESSION_COOKIES) expireCookie(response, cookie)
  return response
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleSignOut(request)
}
