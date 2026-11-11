import { NextRequest, NextResponse } from 'next/server'
import { handlePasskeyDelete } from '@/lib/passkey-route'
import { isJsonContentType, isSameOrigin } from '../../../sign-out/route'

/**
 * Delete a passkey (POST /api/session/passkey/:id/delete). Requires the
 * current password. Another user's id is 404.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  const { id } = await context.params
  return handlePasskeyDelete(request, id)
}
