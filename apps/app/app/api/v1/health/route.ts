import { NextResponse } from 'next/server'
import { edition } from '@hitly/cloud'

/**
 * Unauthenticated monitoring probe — deliberately NOT rate limited (see
 * lib/rest-limit.ts): a health check must never be throttled and must never
 * write to the limiter table.
 */
export async function GET() {
  return NextResponse.json({ ok: true, product: 'hitly', edition: edition.id })
}
