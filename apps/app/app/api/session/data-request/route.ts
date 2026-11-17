import { NextRequest, NextResponse } from 'next/server'
import { handleDataRequest } from '@/lib/data-request'
import { isJsonContentType, isSameOrigin } from '../sign-out/route'

/**
 * POST /api/session/data-request — capture a "Request my data" support ask.
 *
 * Same-origin POST from the signed-in web client only (same request policy
 * as sign-out: the browser always sends Origin; a foreign or missing Origin
 * is rejected before any session work). The handler (lib/data-request.ts)
 * does session auth (401 first), the per-account rate limit (429 +
 * Retry-After), the idempotent insert (201 new / 200 already open) and the
 * UK GDPR one-month deadline in the response. The body is not read: the ask
 * always belongs to the session user's own account.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleDataRequest(request)
}
