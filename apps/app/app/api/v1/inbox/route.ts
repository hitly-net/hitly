import { NextResponse } from 'next/server'
import { listInboxItems } from '@/lib/inbox'
import { requireApiWorkspace } from '@/lib/api-session'
import { parseListFilters } from '@/lib/list-filters'

export async function GET(request: Request) {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) return NextResponse.json({ items: [], nextCursor: null })

  const url = new URL(request.url)
  const filters = parseListFilters({
    scope: url.searchParams.get('scope') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    projectId: url.searchParams.get('projectId') ?? undefined,
  })
  const items = await listInboxItems({
    workspaceId: ctx.workspace.id,
    userId: ctx.session.user.id,
    workspaceRole: ctx.role,
    projectId: filters.projectId,
    scope: filters.scope,
    q: filters.q,
  })
  return NextResponse.json({ items, nextCursor: null })
}
