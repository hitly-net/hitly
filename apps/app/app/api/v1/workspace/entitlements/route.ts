import { NextResponse } from 'next/server'
import { requireApiWorkspace } from '@/lib/api-session'
import { getEntitlementsForWorkspace } from '@/lib/tier-entitlements'

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
export async function GET() {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    plan: ctx.workspace.plan,
    features: await getEntitlementsForWorkspace(ctx.workspace),
  })
}
