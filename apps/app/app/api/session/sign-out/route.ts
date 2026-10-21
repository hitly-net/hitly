import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { WORKSPACE_COOKIE } from '@/lib/context'

/**
 * Server-side sign-out.
 *
 * The better-auth session cookie is HttpOnly, so the browser cannot drop it
 * from JavaScript and a failed call to /api/auth/sign-out used to leave a
 * fully valid session behind. This route:
 *
 * 1. best-effort revokes the current session via the existing server auth
 *    instance (no new auth logic; a failure is logged, never fatal), and
 * 2. ALWAYS expires the session cookie(s) — both the plain and the
 *    __Secure- better-auth variants plus the workspace cookie — on the
 *    response, so the session is ended whether or not revocation succeeded.
 *
 * It returns 200 JSON; the client always redirects to /login afterwards.
 */

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

export async function handleSignOut(
  request: { headers: Headers },
  deps: { revoke?: () => Promise<unknown> } = {},
): Promise<NextResponse> {
  try {
    const authInstance = auth
    const revoke = deps.revoke ?? (authInstance ? () => authInstance.api.signOut({ headers: request.headers }) : undefined)
    if (revoke) await revoke()
  } catch (error) {
    // Revocation failed, threw (e.g. 401 for an already-ended session) or
    // there is no session to revoke: cookie expiry below still ends it.
    console.error('[hitly sign-out] Session revocation failed:', error)
  }
  const response = NextResponse.json({ ok: true })
  for (const cookie of SESSION_COOKIES) expireCookie(response, cookie)
  return response
}

export function POST(request: NextRequest) {
  return handleSignOut(request)
}
