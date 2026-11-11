import { NextRequest, NextResponse } from 'next/server'
import { handlePasskeyGet, handlePasskeyRename } from '@/lib/passkey-route'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/**
 * One of the signed-in user's passkeys (GET /api/session/passkey/:id).
 * Another user's id is 404.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return handlePasskeyGet(request, id)
}

/**
 * Rename a passkey (POST /api/session/passkey/:id). Another user's id is 404.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  const { id } = await context.params
  return handlePasskeyRename(request, id)
}
