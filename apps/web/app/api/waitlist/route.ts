import { NextResponse } from 'next/server'
import { parseWaitlistPayload, waitlistWebhookUrl } from '@/lib/waitlist'

export async function POST(request: Request) {
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const parsed = parseWaitlistPayload(json)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const webhook = waitlistWebhookUrl()
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(parsed.data),
  })

  if (!response.ok) {
    return NextResponse.json({ error: 'Could not join the waitlist. Try again.' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
