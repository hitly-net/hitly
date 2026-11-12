import { NextResponse } from 'next/server'
import { requireApiWorkspace } from '@/lib/api-session'
import { getEntitlementsForWorkspace } from '@/lib/tier-entitlements'

type ApiWorkspaceCtx =
  | { ok: false; error: NextResponse }
  | { ok: true; workspace: { plan: string } | null }

export type EntitlementsRouteDeps = {
  /** Test seam. Production default: requireApiWorkspace (session + workspace). */
  resolveSession?: () => Promise<ApiWorkspaceCtx>
  /** Test seam. Production default: getEntitlementsForWorkspace (DB map via can()). */
  entitlements?: (workspace: { plan: string }) => Promise<Record<string, boolean>>
}

/**
 * GET /api/v1/workspace/entitlements
 *
 * The tier entitlements map evaluated for the session's current workspace:
 * `{ plan, features }` with one boolean per registered feature. Clients
 * (settings pages, mobile, the cloud SSO setup flow) read this to decide
 * which MFA/SSO affordances to offer. Server-side enforcement never trusts
 * this response — every guarded action calls the same helper (can()) on
 * its own. Values are data in the tier_entitlements table: a plan gains or
 * loses a feature via UPDATE, without a deploy.
 */
export async function GET(
  _request?: Request,
  // Intersection keeps Next's typed-routes validator happy (the second
  // argument must also accept the route context it passes at runtime);
  // tests pass a plain EntitlementsRouteDeps.
  deps: EntitlementsRouteDeps & Record<string, unknown> = {},
): Promise<NextResponse> {
  const resolveSession = deps.resolveSession ?? (requireApiWorkspace as () => Promise<ApiWorkspaceCtx>)
  const ctx = await resolveSession()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const entitlements = deps.entitlements ?? getEntitlementsForWorkspace
  return NextResponse.json({
    plan: ctx.workspace.plan,
    features: await entitlements(ctx.workspace),
  })
}
