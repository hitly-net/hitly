import { NextResponse } from 'next/server'
import { ingestApproval } from '@/lib/approvals'

export async function POST(request: Request) {
  try {
    const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
    }

    const body = (await request.json()) as Record<string, unknown>
    const result = await ingestApproval({
      apiKey,
      body,
      idempotencyKey: request.headers.get('idempotency-key'),
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({
      id: result.approval.id,
      status: result.approval.status,
      replayed: result.replayed,
      envelope: result.approval.envelope,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
