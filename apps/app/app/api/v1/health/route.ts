import { NextResponse } from 'next/server'
import { edition } from '@hitly/cloud'
import { applyRestLimit, clientAddressRestSubject } from '@/lib/rest-limit'

export async function GET(request: Request) {
  const limited = await applyRestLimit('read', clientAddressRestSubject(request.headers))
  if (limited) return limited
  return NextResponse.json({ ok: true, product: 'hitly', edition: edition.id })
}
