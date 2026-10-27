import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { findContextItem, isOpenApprovalStatus, type ApprovalEnvelope } from '@hitly/core'
import { approvals } from '@hitly/db/schema'
import { withApiTenant } from '@/lib/api-session'
import { canDecide, getProjectAccess } from '@/lib/rbac'
import { requireDb } from '@/lib/tenant'
import { decodeTenantJson } from '@/lib/tenant-crypto'
import { recordContextOpen } from '@/lib/context-opens'

/**
 * Record that the signed-in reviewer opened a context item (hitl-spec 3.7/5.2).
 *
 * Opens are recorded per reviewer and per open (not only the first), as `opened`
 * project audit events carrying `openedAt`. `mustOpen` gating reads them back per
 * reviewer: an answer that skipped a must-open item is refused at decide time.
 * The host never fetches the target itself; the client opens the real URL in a
 * new tab and reports the open here (spec 5.2 allows client-reported opens).
 */
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
    if (!isOpenApprovalStatus(approval.status)) {
      return NextResponse.json({ error: 'Approval is not awaiting a decision' }, { status: 409 })
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
    if (!ref) return NextResponse.json({ error: 'ref is required' }, { status: 400 })

    const envelope = (await decodeTenantJson(ctx.workspace.id, approval.envelope)) as unknown as ApprovalEnvelope
    const item = findContextItem(envelope, ref)
    if (!item) return NextResponse.json({ error: 'Unknown context item' }, { status: 404 })

    const openEvent = await recordContextOpen({
      workspaceId: ctx.workspace.id,
      projectId: approval.projectId,
      approvalId: approval.id,
      ref: item.ref,
      url: item.url,
      userId: ctx.session.user.id,
    })
    return NextResponse.json({ ok: true, ref: item.ref, openedAt: openEvent.openedAt })
  })
  return result
}
