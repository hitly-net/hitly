import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { inviteRouteDeps } from '@/lib/invite-route-deps'
import { handleInviteLookup } from '@/lib/invite-routes'

export async function POST(request: Request) {
  if (!db) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  return handleInviteLookup(request, inviteRouteDeps)
}
