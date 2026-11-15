import { NextRequest, NextResponse } from 'next/server'
import { handleDeletionReauth } from '@/lib/account-deletion-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/**
 * POST /api/session/delete-account/reauth — proves the caller is really the
 * signed-in user before the irreversible call will run. Either the current
 * password or a user-verified passkey assertion; either mints a single-use
 * five-minute ticket bound to this account.
 *
 * Same request policy as sign-out / change-email: same-origin application/json
 * only, so a foreign page cannot spend the user's session on it.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleDeletionReauth(request)
}
