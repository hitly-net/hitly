import { NextResponse } from 'next/server'
import { withApiTenant } from '@/lib/api-session'
import { getOriginalRequest, summarizeForLog } from '@/lib/original-request'

/**
 * Serve the ORIGINAL create-once `hitl/request/v0` payload of an approval as
 * canonical JSON for reviewer verification (hitly#98, hitl-spec discussion #5).
 *
 * Session-authenticated reviewer API only — same authentication and tenancy as
 * `GET /api/v1/approvals/{id}` (the approval detail): workspace member with project
 * access, everything else 404. The project API-key path is deliberately absent:
 * origin keys keep their reduced view (`getApprovalForOrigin`) and never read the
 * reviewer-facing payload here.
 *
 * The bytes are exact (no redaction) on purpose — the point is an off-host check of
 * the stored original; see `lib/original-request.ts` for the flagged
 * redaction-vs-exactness decision. Only ids/hashes are logged.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return withApiTenant(async (ctx) => {
    const result = await getOriginalRequest({
      approvalId: id,
      workspaceId: ctx.workspace.id,
      userId: ctx.session.user.id,
      workspaceRole: ctx.role,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    // Log policy (hitly#98): ids and hashes only, never the payload bytes.
    console.info('[original-request] served', JSON.stringify(summarizeForLog(result)))

    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  })
}
