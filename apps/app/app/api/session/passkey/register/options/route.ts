import { NextRequest, NextResponse } from 'next/server'
import { handlePasskeyRegisterOptions } from '@/lib/passkey-route'
import { isJsonContentType, isSameOrigin } from '../../../sign-out/route'

/**
 * Start passkey registration (POST /api/session/passkey/register/options).
 * Requires a current-password check. The WebAuthn challenge is single-use.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handlePasskeyRegisterOptions(request)
}
