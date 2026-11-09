import { NextResponse } from 'next/server'
import { ingestApproval, listRequesterPending } from '@/lib/approvals'
import { createOncePolicy } from '@/lib/create-once'
import { argsHash } from '@hitly/core'

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
      return NextResponse.json(
        'code' in result && result.code
          ? { error: result.error, code: result.code }
          : { error: result.error },
        { status: result.status },
      )
    }

    const envelope = result.approval.envelope as { action?: { args?: Record<string, unknown> } }
    return NextResponse.json({
      id: result.approval.id,
      status: result.approval.status,
      replayed: result.replayed,
      envelope: result.approval.envelope,
      // hitl-spec 3.8 over the stored original args (JCS, b64url SHA-256).
      argsHash: await argsHash(envelope.action?.args ?? {}),
      // hitl-spec 3.2: the published create-once retention period.
      createOnce: createOncePolicy(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * GET /api/v1/approvals — the requester's open requests (project API key).
 * Only requests created by the calling key are listed. Query: `projectId`
 * (must be the key's project), `status=open` (the only value; default),
 * `limit` (1-200, default 50).
 */
export async function GET(request: Request) {
  const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!apiKey) return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
  const url = new URL(request.url)
  const status = url.searchParams.get('status') ?? 'open'
  if (status !== 'open') {
    return NextResponse.json({ error: 'Unsupported status filter; only status=open is available' }, { status: 400 })
  }
  const limitParam = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) return NextResponse.json({ error: 'limit must be a whole number' }, { status: 400 })
    limit = Number(limitParam)
  }
  const result = await listRequesterPending({ apiKey, projectId: url.searchParams.get('projectId') ?? undefined, limit })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ projectId: result.projectId, status: 'open', items: result.items })
}
