import { NextRequest, NextResponse } from 'next/server'
import { handleMfaVerify } from '@/lib/mfa-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/**
 * Second login step (POST /api/session/mfa/verify). Requires the MFA
 * challenge cookie, not a full session. A TOTP code or a recovery code
 * completes sign-in.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleMfaVerify(request)
}
