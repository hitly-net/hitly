import { auth } from '@/lib/auth'
import { withNativeAuthOrigin } from '@/lib/cors'
import { holdPasswordSignInIfMfa } from '@/lib/mfa-sign-in'
import {
  assertionHasUserVerification,
  isPasskeyPluginAuthenticatePath,
  isPasskeyPluginManagementPath,
  withRequiredUserVerification,
} from '@/lib/passkey'
import { toNextJsHandler } from 'better-auth/next-js'
import { NextResponse } from 'next/server'

function handlers() {
  if (!auth) return null
  return toNextJsHandler(auth)
}

/**
 * Shared entry for both verbs. The auth surface must never answer with 500
 * for a path it does not recognise: better-auth replies to unmatched paths
 * with a bare 404, and this wrapper turns that (or any non-Response result)
 * into a JSON 404, so an unknown auth path is a clean 404 rather than an
 * HTML error page.
 */
// Exported for tests: normalises the auth handler's replies so unknown paths
// resolve to a JSON 404.
export async function handleAuthRequest(
  request: Request,
  run: (request: Request) => Promise<Response>,
): Promise<Response> {
  // Register / list / rename / delete go through /api/session/passkey so
  // they can require the current password. The plugin's own management
  // paths would skip that check.
  if (isPasskeyPluginManagementPath(request.url)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // The stock plugin hardcodes userVerification: preferred and
  // requireUserVerification: false. Reject UV-less assertions before the
  // plugin can mint a session, and rewrite authenticate options to required.
  //
  // LOAD-BEARING: the stock better-auth passkey plugin hardcodes
  // requireUserVerification false for authentication, so removing this
  // pre-check would let UV-less assertions through. Covered by the
  // positive UV tests in lib/passkey.test.ts and lib/passkey.live.test.ts
  // (an assertion with authenticatorData flags bit 0x04 at offset 32 must
  // reach the stock handler; assertionHasUserVerification always returning
  // false would fail those tests).
  if (isPasskeyPluginAuthenticatePath(request.url, '/passkey/verify-authentication') && request.method === 'POST') {
    const body = await request.clone().json().catch(() => null)
    if (!assertionHasUserVerification(body)) {
      return NextResponse.json({ error: 'verification_failed', code: 'USER_VERIFICATION_REQUIRED' }, { status: 400 })
    }
  }
  const response = await run(withNativeAuthOrigin(request))
  if (response instanceof Response) {
    if (response.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (isPasskeyPluginAuthenticatePath(request.url, '/passkey/generate-authenticate-options') && response.ok) {
      return rewriteAuthenticateOptions(response)
    }
    return response
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

async function rewriteAuthenticateOptions(response: Response): Promise<Response> {
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!data || typeof data !== 'object') return response
  const next = NextResponse.json(withRequiredUserVerification(data), { status: response.status })
  for (const cookie of response.headers.getSetCookie()) next.headers.append('set-cookie', cookie)
  const cache = response.headers.get('cache-control')
  if (cache) next.headers.set('cache-control', cache)
  next.headers.set('referrer-policy', 'no-referrer')
  return next
}

export async function GET(request: Request) {
  const next = handlers()
  if (!next) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  return handleAuthRequest(request, next.GET)
}

export async function POST(request: Request) {
  const next = handlers()
  if (!next) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  const response = await handleAuthRequest(request, next.POST)
  return holdPasswordSignInIfMfa(request, response)
}
