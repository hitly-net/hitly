import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { retryResume } from '@/lib/approvals'
import { canDecide, getProjectAccess } from '@/lib/rbac'
import { withApiTenant } from '@/lib/api-session'
import { requireDb } from '@/lib/tenant'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return withApiTenant(async (ctx) => {
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

    const result = await retryResume({ approvalId: id, workspaceId: ctx.workspace.id })
    if ('approval' in result && result.approval) {
      return NextResponse.json({
        id,
        status: result.status,
        resumeError: result.resumeError,
        resumeResponse: result.resumeResponse,
      })
    }
    return NextResponse.json(
      { error: 'error' in result ? result.error : 'Retry failed' },
      { status: 'status' in result && typeof result.status === 'number' ? result.status : 500 },
    )
  })
}
