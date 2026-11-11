import { NextRequest, NextResponse } from 'next/server'
import { handlePasskeyRegister } from '@/lib/passkey-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/**
 * Finish passkey registration (POST /api/session/passkey/register).
 * Consumes the short-lived challenge issued after the password check.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handlePasskeyRegister(request)
}
