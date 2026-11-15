import { NextRequest, NextResponse } from 'next/server'
import { handleDeletionReauthOptions } from '@/lib/account-deletion-route'
import { isJsonContentType, isSameOrigin } from '../../../sign-out/route'

/**
 * POST /api/session/delete-account/reauth/options — WebAuthn assertion
 * options for the signed-in user's own passkeys, so a user-verified passkey
 * can serve as the re-auth for account deletion.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleDeletionReauthOptions(request)
}
