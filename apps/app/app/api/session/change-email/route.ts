import { NextRequest, NextResponse } from 'next/server'
import { handleEmailChange } from '@/lib/email-change-route'
import { isJsonContentType, isSameOrigin } from '../sign-out/route'

/**
 * Signed-in email change request (POST /api/session/change-email).
 *
 * Same request policy as sign-out and password-change: only same-origin
 * (Origin matches the configured app URL) application/json requests are
 * accepted, so a foreign page cannot submit the form with the user's
 * session cookie. The session check, the attempt throttle, the current-
 * password verification, pending storage and the confirmation email all
 * live in lib/email-change-route.ts.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleEmailChange(request)
}
