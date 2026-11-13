import { NextResponse } from 'next/server'
import { listRequesterPending } from '@/lib/approvals'
import { handleIngestPost } from '@/lib/ingest-route'
import { applyRestLimit, apiKeyRestSubject } from '@/lib/rest-limit'
import { parseCursorParam, parseLimitParam } from '@/lib/list-cursor'

export async function POST(request: Request) {
  return handleIngestPost(request)
}

/**
 * GET /api/v1/approvals — the requester's open requests (project API key).
 * Only requests created by the calling key are listed. Query: `projectId`
 * (must be the key's project), `status=open` (the default; `status=pending`
 * is an exact alias of `open`), `limit` (1-200, default 50), `cursor`
 * (opaque, from `nextCursor`). Order is created_at DESC, id DESC (#107).
 */
export async function GET(request: Request) {
  const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!apiKey) return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
  const limited = await applyRestLimit('read', apiKeyRestSubject(apiKey))
  if (limited) return limited
  const url = new URL(request.url)
  const status = url.searchParams.get('status') ?? 'open'
  // MCP list_pending sends status=pending. Treat it as open; do not widen to other values.
  if (status !== 'open' && status !== 'pending') {
    return NextResponse.json({ error: 'Unsupported status filter; only status=open is available' }, { status: 400 })
  }
  const limitParsed = parseLimitParam(url.searchParams.get('limit'))
  if (!limitParsed.ok) return NextResponse.json({ error: limitParsed.error }, { status: 400 })
  const cursorParsed = parseCursorParam(url.searchParams.get('cursor'))
  if (!cursorParsed.ok) return NextResponse.json({ error: cursorParsed.error }, { status: 400 })
  const result = await listRequesterPending({
    apiKey,
    projectId: url.searchParams.get('projectId') ?? undefined,
    limit: limitParsed.limit,
    cursor: cursorParsed.cursor,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({
    projectId: result.projectId,
    status: 'open',
    items: result.items,
    nextCursor: result.nextCursor,
  })
}
