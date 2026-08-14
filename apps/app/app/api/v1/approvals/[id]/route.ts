import { NextResponse } from 'next/server'
import { getApprovalDetail } from '@/lib/approval-detail'
import { getApprovalForOrigin } from '@/lib/approvals'
import { requireApiWorkspace } from '@/lib/api-session'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (apiKey) {
    const origin = await getApprovalForOrigin({ apiKey, approvalId: id })
    if (origin.ok) {
      return NextResponse.json({
        id: origin.id,
        status: origin.status,
        decision: origin.decision,
        response: origin.response,
      })
    }
    if (origin.status !== 401) {
      return NextResponse.json({ error: origin.error }, { status: origin.status })
    }
  }

  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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
