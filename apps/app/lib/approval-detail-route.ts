import { NextResponse } from 'next/server'
import type { requireApiWorkspace } from './api-session'
import type { getApprovalDetail } from './approval-detail'
import type { getApprovalForOrigin } from './approvals'

type RequireApiWorkspaceFn = typeof requireApiWorkspace
type GetApprovalDetailFn = typeof getApprovalDetail
type GetApprovalForOriginFn = typeof getApprovalForOrigin

/**
 * Factory for GET /api/v1/approvals/:id.
 * Origin resume uses a project API key (unredacted). Mobile/session uses
 * getApprovalDetail after a 401 fallthrough. Deps are injectable so tests can
 * drive the session path without booting Next auth.
 */
export function createApprovalDetailGet(deps: {
  requireApiWorkspace: RequireApiWorkspaceFn
  getApprovalDetail: GetApprovalDetailFn
  getApprovalForOrigin: GetApprovalForOriginFn
}) {
  return async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params
    const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (apiKey) {
      const origin = await deps.getApprovalForOrigin({ apiKey, approvalId: id })
      if (origin.ok) {
        const { ok: _ok, ...body } = origin
        void _ok
        return NextResponse.json(body)
      }
      if (origin.status !== 401) {
        return NextResponse.json({ error: origin.error }, { status: origin.status })
      }
    }

    const ctx = await deps.requireApiWorkspace()
    if (!ctx.ok) return ctx.error
    if (!ctx.workspace || !ctx.role) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const detail = await deps.getApprovalDetail({
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
}
