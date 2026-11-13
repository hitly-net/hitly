import { NextRequest, NextResponse } from 'next/server'
import { handleDataExport } from '@/lib/gdpr-export'
import { isJsonContentType, isSameOrigin } from '../sign-out/route'

/**
 * POST /api/session/export — GDPR data export (JSON in a zip).
 *
 * Same-origin POST from the signed-in web client only (same request policy as
 * sign-out: the browser always sends Origin; a foreign or missing Origin is
 * rejected before any session work). The handler (lib/gdpr-export.ts) does
 * session auth, the per-user once-per-hour limit (429 + Retry-After), builds
 * the zip and records the data_export security event.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  return handleDataExport(request)
}
