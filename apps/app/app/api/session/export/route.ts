import { NextRequest, NextResponse } from 'next/server'
import { handleAccountExport } from '@/lib/account-deletion-route'
import { isSameOrigin } from '../sign-out/route'

/**
 * GET /api/session/export — the "export first" download the deletion
 * confirmation offers. Covers the account's own profile and the contents of
 * the sole-member workspaces the deletion destroys; shared-workspace data
 * belongs to the remaining members and is not exported. Project credentials
 * are redacted and API keys export metadata only.
 */
export async function GET(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return handleAccountExport(request)
}
