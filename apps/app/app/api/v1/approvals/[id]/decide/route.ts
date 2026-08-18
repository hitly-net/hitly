import { NextResponse } from 'next/server'
import { decideApproval, parseDecisionBody } from '@/lib/approvals'
import { canDecide, getProjectAccess } from '@/lib/rbac'
import { withApiTenant } from '@/lib/api-session'
import { requireDb } from '@/lib/tenant'
import { and, eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const result = await withApiTenant(async (ctx) => {
    const database = requireDb()
    const rows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.workspaceId, ctx.workspace.id)))
      .limit(1)
    const approval = rows[0]
    if (!approval) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: ctx.session.user.id,
      workspaceRole: ctx.role,
    })
    if (!canDecide(access)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = (await request.json()) as Record<string, unknown>
    const payload = parseDecisionBody(body)
    if (!payload) return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })

    const decided = await decideApproval({
      approvalId: id,
      actorUserId: ctx.session.user.id,
      payload,
      workspaceId: ctx.workspace.id,
    })
    if ('error' in decided && decided.error) {
      return NextResponse.json({ error: decided.error }, { status: decided.status })
    }
    return NextResponse.json({
      id,
      status: decided.status,
      decision: payload.decision,
      resumeError: decided.resumeError,
      resumeResponse: decided.resumeResponse,
    })
  })
  return result
}
