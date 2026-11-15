import { NextRequest, NextResponse } from 'next/server'
import { handleAccountDeletion } from '@/lib/account-deletion-route'
import { isJsonContentType, isSameOrigin } from '../sign-out/route'

/**
 * POST /api/session/delete-account — the irreversible call.
 *
 * Requires, all re-checked server-side: a live session, the typed confirmation
 * (exactly "DELETE"), and an unspent re-auth ticket from
 * /api/session/delete-account/reauth. Refuses with 409 while the user is the
 * sole owner of a shared workspace or still owns an active paid subscription.
 *
 * There is no grace period: on success the account and the data that belongs
 * to it alone are gone, the confirmation email says so, and the reply expires
 * the session cookie.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleAccountDeletion(request)
}
