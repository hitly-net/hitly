import { NextResponse } from 'next/server'
import { markApprovalPresented } from '@/lib/approvals'
import { withApiTenant } from '@/lib/api-session'
import { clientFromHeaders } from '@/lib/request-client'

/**
 * Record that the signed-in reviewer was FIRST shown this ask (hitl-spec 5.2).
 *
 * Explicit POST rather than piggy-backing on GET/RSC render, so Next prefetch,
 * RefreshOnFocus re-renders and inbox polling are never counted as "shown".
 * Idempotent: the first call wins; later calls return the existing
 * `presentedAt` without touching the chain. Readers who cannot decide, closed
 * items and expired items are no-ops (200 with `presentedAt: null` or the
 * existing value) - only missing approvals or no project access 404.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const result = await withApiTenant(async (ctx) => {
    const client = clientFromHeaders(request.headers)
    const outcome = await markApprovalPresented({
      approvalId: id,
      actorUserId: ctx.session.user.id,
      workspaceRole: ctx.role,
      workspaceId: ctx.workspace.id,
      client,
    })
    if ('error' in outcome) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    }
    return NextResponse.json({ id, presentedAt: outcome.presentedAt })
  })
  return result
}
