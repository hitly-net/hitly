import { NextResponse } from 'next/server'
import { ingestApproval } from '@/lib/approvals'

export async function POST(request: Request) {
  try {
    const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
    }

    const raw = await request.text()
    if (!raw.trim()) {
      return NextResponse.json(
        {
          error:
            'JSON body required. Put plugin, projectId, runId, and resumeUrl in the POST body (n8n: Send Body), not query parameters.',
        },
        { status: 400 },
      )
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'JSON body must be an object' }, { status: 400 })
    }
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
