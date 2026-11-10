import { NextRequest, NextResponse } from 'next/server'
import { handleMfaEnrol } from '@/lib/mfa-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/**
 * Start authenticator-app MFA enrolment (POST /api/session/mfa/enrol).
 * Requires a current-password check. MFA stays inactive until confirm.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleMfaEnrol(request)
}
