import { NextResponse } from 'next/server'
import { edition } from '@hitly/cloud'

export async function GET() {
  return NextResponse.json({ ok: true, product: 'hitly', edition: edition.id })
}
