import { NextResponse } from 'next/server'
import { getApprovalDetail } from '@/lib/approval-detail'
import { requireApiWorkspace } from '@/lib/api-session'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { id } = await context.params
  const detail = await getApprovalDetail({
    approvalId: id,
    userId: ctx.session.user.id,
    workspaceId: ctx.workspace.id,
    workspaceRole: ctx.role,
  })
  if (!detail.ok) {
    return NextResponse.json({ error: detail.error }, { status: detail.status })
  }
  return NextResponse.json(detail)
}
