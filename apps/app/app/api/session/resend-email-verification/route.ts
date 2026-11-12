import { NextRequest, NextResponse } from 'next/server'
import { handleResendEmailVerification } from '@/lib/email-verification-route'
import { isJsonContentType, isSameOrigin } from '../sign-out/route'

/**
 * Signed-in resend of the public sign-up verification email
 * (POST /api/session/resend-email-verification).
 *
 * Same-origin + JSON. The session selects the account; the body is ignored,
 * so a caller cannot ask about some other address. The success body does not
 * say whether a message was sent.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleResendEmailVerification(request)
}
