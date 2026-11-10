import { NextRequest, NextResponse } from 'next/server'
import { handleEmailChangeVerify } from '@/lib/email-change-route'
import { isJsonContentType, isSameOrigin } from '../sign-out/route'

/**
 * Confirm a pending email change (POST /api/session/verify-email-change).
 *
 * Same-origin + JSON like the other session routes. The token in the body
 * is the proof; a session is not required. Expired, used and unknown tokens
 * all answer the same error. The token is never logged.
 *
 * GET and HEAD are refused without touching the pending row, so a mail
 * scanner or prefetch of this URL cannot consume the token.
 */

function methodNotAllowed() {
  const response = new NextResponse(null, { status: 405 })
  response.headers.set('allow', 'POST')
  response.headers.set('cache-control', 'no-store')
  response.headers.set('referrer-policy', 'no-referrer')
  return response
}

export function GET() {
  return methodNotAllowed()
}

export function HEAD() {
  return methodNotAllowed()
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  return handleEmailChangeVerify(body.token)
}
