import { NextRequest, NextResponse } from 'next/server'
import { handlePasswordChange } from '@/lib/password-change-route'
import { isJsonContentType, isSameOrigin } from '../sign-out/route'

/**
 * Signed-in password change (POST /api/session/change-password).
 *
 * Same request policy as sign-out: only same-origin (Origin matches the
 * configured app URL) application/json requests are accepted, so a foreign
 * page cannot submit the form with the user's session cookie. The session
 * check, the attempt throttle, the current-password verification, the
 * revocation of other sessions and the notification email all live in
 * lib/password-change.ts.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handlePasswordChange(request)
}
