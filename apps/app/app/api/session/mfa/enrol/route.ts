import { NextRequest, NextResponse } from 'next/server'
import { handleMfaEnrol } from '@/lib/mfa-route'
import { canForCurrentWorkspace } from '@/lib/tier-entitlements'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

export type MfaEnrolRouteDeps = {
  /**
   * Test seam for the tier gate. Receives the feature name the route asks
   * for (always 'mfa' in production), so tests can pin the name and the
   * decision. Production default: canForCurrentWorkspace.
   */
  featureCheck?: (feature: string) => Promise<boolean>
}

/**
 * Start authenticator-app MFA enrolment (POST /api/session/mfa/enrol).
 * Requires a current-password check. MFA stays inactive until confirm.
 *
 * Tier gate: the `mfa` feature (tier_entitlements map, seeded for every
 * plan) is checked against the session's current workspace before any
 * enrolment state is created. Deny (or a failed lookup) answers 403 —
 * never a 500, never enrolment.
 */
export async function POST(
  request: NextRequest,
  // Intersection keeps Next's typed-routes validator happy (the second
  // argument must also accept the route context it passes at runtime);
  // tests pass a plain MfaEnrolRouteDeps.
  deps: MfaEnrolRouteDeps & Record<string, unknown> = {},
): Promise<NextResponse> {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  const featureCheck = deps.featureCheck ?? ((feature: string) => canForCurrentWorkspace(feature))
  if (!(await featureCheck('mfa'))) {
    return NextResponse.json({ error: 'feature_unavailable', code: 'FEATURE_UNAVAILABLE' }, { status: 403 })
  }
  return handleMfaEnrol(request)
}
