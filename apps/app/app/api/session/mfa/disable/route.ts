import { NextRequest, NextResponse } from 'next/server'
import { handleMfaDisable } from '@/lib/mfa-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/** Disable MFA after a current-password check (POST /api/session/mfa/disable). */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleMfaDisable(request)
}
