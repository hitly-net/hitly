import { auth } from '@/lib/auth'
import { withNativeAuthOrigin } from '@/lib/cors'
import { toNextJsHandler } from 'better-auth/next-js'
import { NextResponse } from 'next/server'

function handlers() {
  if (!auth) return null
  return toNextJsHandler(auth)
}

export async function GET(request: Request) {
  const next = handlers()
  if (!next) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  return next.GET(withNativeAuthOrigin(request))
}

export async function POST(request: Request) {
  const next = handlers()
  if (!next) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  return next.POST(withNativeAuthOrigin(request))
}
