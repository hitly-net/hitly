import { auth } from '@/lib/auth'
import { withNativeAuthOrigin } from '@/lib/cors'
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
async function handleAuthRequest(
  request: Request,
  run: (request: Request) => Promise<Response>,
): Promise<Response> {
  const response = await run(withNativeAuthOrigin(request))
  if (response instanceof Response) {
    if (response.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return response
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export async function GET(request: Request) {
  const next = handlers()
  if (!next) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  return handleAuthRequest(request, next.GET)
}

export async function POST(request: Request) {
  const next = handlers()
  if (!next) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  return handleAuthRequest(request, next.POST)
}
