import { NextResponse } from 'next/server'
import type { ApiTenantOk } from './api-session'
import {
  getOriginalRequest,
  summarizeForLog,
  type OriginalRequestOk,
  type OriginalRequestErr,
} from './original-request'

type WithApiTenantFn = <T>(fn: (ctx: ApiTenantOk) => Promise<T>) => Promise<T | NextResponse>
type GetOriginalRequestFn = typeof getOriginalRequest

/**
 * Factory for GET /api/v1/approvals/:id/original-request (hitly#98).
 * Deps are injectable so route tests can pin session/API-key refusal, no-store,
 * and log policy without booting Next auth.
 */
export function createOriginalRequestGet(deps: {
  withApiTenant: WithApiTenantFn
  getOriginalRequest: GetOriginalRequestFn
  logInfo?: (message?: unknown, ...optionalParams: unknown[]) => void
}) {
  const logInfo = deps.logInfo ?? console.info.bind(console)
  return async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params
    return deps.withApiTenant(async (ctx) => {
      const result: OriginalRequestOk | OriginalRequestErr = await deps.getOriginalRequest({
        approvalId: id,
        workspaceId: ctx.workspace.id,
        userId: ctx.session.user.id,
        workspaceRole: ctx.role,
      })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

      // Log policy (hitly#98): ids and hashes only, never the payload.
      logInfo('[original-request] served', JSON.stringify(summarizeForLog(result)))

      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
    })
  }
}
