import { NextRequest, NextResponse } from 'next/server'
import { handleDeletionPreview } from '@/lib/account-deletion-route'
import { isSameOrigin } from '../../sign-out/route'

/**
 * GET /api/session/delete-account/preview — what the confirmation step shows
 * before anything is destroyed: the sole-member workspaces that go with the
 * account (with project / API-key / decision counts), the shared workspaces
 * that survive, and any blocker that refuses the deletion.
 *
 * Read-only, but still session-scoped and same-origin: the reply names the
 * user's workspaces, so a foreign page must not be able to read it.
 */
export async function GET(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return handleDeletionPreview(request)
}
