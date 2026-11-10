import { NextRequest, NextResponse } from 'next/server'
import { handleMfaRecoveryCodes } from '@/lib/mfa-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/**
 * Replace recovery codes after a current-password check plus TOTP or recovery
 * code (POST /api/session/mfa/recovery-codes). Plaintext is returned once.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleMfaRecoveryCodes(request)
}
