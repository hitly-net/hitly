import { NextResponse } from 'next/server'
import { listInboxItems } from '@/lib/inbox'
import { requireApiWorkspace } from '@/lib/api-session'
import { parseListFilters } from '@/lib/list-filters'
import { parseCursorParam, parseLimitParam } from '@/lib/list-cursor'

export async function GET(request: Request) {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) return NextResponse.json({ items: [], nextCursor: null })

  const url = new URL(request.url)
  const limitParsed = parseLimitParam(url.searchParams.get('limit'))
  if (!limitParsed.ok) return NextResponse.json({ error: limitParsed.error }, { status: 400 })
  const cursorParsed = parseCursorParam(url.searchParams.get('cursor'))
  if (!cursorParsed.ok) return NextResponse.json({ error: cursorParsed.error }, { status: 400 })
  const filters = parseListFilters({
    scope: url.searchParams.get('scope') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    projectId: url.searchParams.get('projectId') ?? undefined,
  })
  const { items, nextCursor } = await listInboxItems({
    workspaceId: ctx.workspace.id,
    userId: ctx.session.user.id,
    workspaceRole: ctx.role,
    projectId: filters.projectId,
    scope: filters.scope,
    q: filters.q,
    limit: limitParsed.limit,
    cursor: cursorParsed.cursor,
  })
  return NextResponse.json({ items, nextCursor })
}
