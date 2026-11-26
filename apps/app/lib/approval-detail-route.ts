import { NextResponse } from 'next/server'
import type { requireApiWorkspace } from './api-session'
import type { getApprovalDetail } from './approval-detail'
import type { getApprovalForOrigin } from './approvals'
import { authenticateProjectKey } from './approvals'
import { applyFailedAuthLimit, applyRestLimit, apiKeyRestSubject, type RestLimitAcquire } from './rest-limit'
import { isWellFormedBearer } from './keys'

type RequireApiWorkspaceFn = typeof requireApiWorkspace
type GetApprovalDetailFn = typeof getApprovalDetail
type GetApprovalForOriginFn = typeof getApprovalForOrigin

/**
 * Factory for GET /api/v1/approvals/:id.
 * Origin resume uses a project API key (unredacted). Mobile/session uses
 * getApprovalDetail after a 401 fallthrough. Deps are injectable so tests can
 * drive the session path without booting Next auth.
 *
 * Rate limiting (rest-read, subject = SHA-256 of the key): authentication is
 * separate from the lookup, and an authenticated key is counted per key
 * IMMEDIATELY after it authenticates — whatever the lookup then returns, so a
 * key probing unknown or foreign ids still burns its read budget. An
 * unverified key never reaches the per-key budget; it counts per client
 * address in the failed-auth budget (never per unverified subject). A
 * bearer that is neither a key nor a valid session is likewise counted per
 * address — but only AFTER the session check fails, so valid bearer session
 * tokens (mobile reviewers) are never counted.
 */
export function createApprovalDetailGet(deps: {
  requireApiWorkspace: RequireApiWorkspaceFn
  getApprovalDetail: GetApprovalDetailFn
  getApprovalForOrigin: GetApprovalForOriginFn
  authenticate?: (apiKey: string) => Promise<unknown | null>
  restAcquire?: RestLimitAcquire
  failedAcquire?: RestLimitAcquire
}) {
  return async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params
    const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (apiKey && isWellFormedBearer(apiKey)) {
      const authn = deps.authenticate ? await deps.authenticate(apiKey) : await authenticateProjectKey(apiKey)
      if (authn) {
        // Count per key as soon as the key authenticates, BEFORE the read,
        // whatever the lookup below returns (own id, foreign id, unknown id).
        const limited = await applyRestLimit('read', apiKeyRestSubject(apiKey), deps.restAcquire)
        if (limited) return limited
        const origin = await deps.getApprovalForOrigin({ apiKey, approvalId: id })
        if (origin.ok) {
          const { ok: _ok, ...body } = origin
          void _ok
          return NextResponse.json(body)
        }
        if (origin.status !== 401) {
          return NextResponse.json({ error: origin.error }, { status: origin.status })
        }
      } else {
        const failed = await applyFailedAuthLimit(request, deps.failedAcquire)
        if (failed) return failed
      }
    }
    // A bearer that is not a well-formed API key may be a Better Auth bearer
    // SESSION token (mobile reviewers): it must NOT be counted up front. It
    // counts in failed-auth only if the session check below fails to
    // authenticate (401) — a 429 from the session's own read budget or a 503
    // (auth not configured) is not a failed login. Same shape as cancel's
    // `sessionResponse.status === 401` gate.
    const malformedBearer = apiKey ? !isWellFormedBearer(apiKey) : false

    const ctx = await deps.requireApiWorkspace()
    if (!ctx.ok) {
      if (apiKey && malformedBearer && ctx.error.status === 401) {
        const failed = await applyFailedAuthLimit(request, deps.failedAcquire)
        if (failed) return failed
      }
      return ctx.error
    }
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
