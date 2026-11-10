import { NextRequest, NextResponse } from 'next/server'
import { handleMfaConfirm } from '@/lib/mfa-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/** Confirm pending MFA with a valid TOTP code (POST /api/session/mfa/confirm). */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleMfaConfirm(request)
}
