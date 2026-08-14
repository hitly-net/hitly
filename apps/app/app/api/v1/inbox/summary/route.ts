import { NextResponse } from 'next/server'
import { inboxSummary } from '@/lib/inbox'
import { requireApiWorkspace } from '@/lib/api-session'

export async function GET(request: Request) {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) {
    return NextResponse.json({ pending: 0, failedResume: 0, decidedToday: 0, projectCount: 0 })
  }

  const url = new URL(request.url)
  const projectId = url.searchParams.get('projectId')?.trim() || undefined
  const summary = await inboxSummary({
    workspaceId: ctx.workspace.id,
    userId: ctx.session.user.id,
    workspaceRole: ctx.role,
    projectId,
  })
  return NextResponse.json(summary)
}
