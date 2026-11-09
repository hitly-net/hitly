import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { cancelApproval, cancelApprovalAsRequester } from '@/lib/approvals'
import { canDecide, getProjectAccess } from '@/lib/rbac'
import { withApiTenant } from '@/lib/api-session'
import { requireDb } from '@/lib/tenant'

async function readReason(request: Request): Promise<string | undefined> {
  const text = await request.text().catch(() => '')
  if (!text.trim()) return undefined
  try {
    const body = JSON.parse(text) as { reason?: unknown }
    return typeof body?.reason === 'string' ? body.reason : undefined
  } catch {
    return undefined
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params

  // Requester cancel with the project API key that created the request.
  // A Bearer value that is not an API key falls through to the session path
  // (reviewer Bearer session tokens on mobile).
  const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (apiKey) {
    const result = await cancelApprovalAsRequester({ apiKey, approvalId: id, reason: await readReason(request) })
    if (result.ok) return NextResponse.json({ id, status: result.status, decision: 'cancel', by: 'requester' })
    if (result.status !== 401) return NextResponse.json({ error: result.error }, { status: result.status })
  }

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

    const result = await cancelApproval({ approvalId: id, actorUserId: ctx.session.user.id, workspaceId: ctx.workspace.id })
    if ('error' in result && result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ id, status: result.status, decision: 'cancel' })
  })
}
