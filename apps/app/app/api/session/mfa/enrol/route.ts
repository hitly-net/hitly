import { NextRequest, NextResponse } from 'next/server'
import { defaultGetSessionUser, handleMfaEnrol } from '@/lib/mfa-route'
import { canForCurrentWorkspace } from '@/lib/tier-entitlements'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

export type MfaEnrolRouteDeps = {
  /**
   * Test seam for the tier gate. Receives the feature name the route asks
   * for (always 'mfa' in production), so tests can pin the name and the
   * decision. Production default: canForCurrentWorkspace.
   */
  featureCheck?: (feature: string) => Promise<boolean>
  /**
   * Test seam for the session check that runs BEFORE the gate. Production
   * default: defaultGetSessionUser (same reader the MFA handlers use).
   */
  authenticate?: (headers: Headers) => Promise<{ id: string } | null>
}

/**
 * Start authenticator-app MFA enrolment (POST /api/session/mfa/enrol).
 * Requires a current-password check. MFA stays inactive until confirm.
 *
 * Order matters (product ruling): authentication first, entitlement
 * second. A signed-out request is 401 unauthorized — it must not learn the
 * plan answer (403 feature_unavailable) and must not be logged as a
 * feature denial. Only an authenticated caller reaches the tier gate;
 * deny (or a failed lookup) answers 403 — never a 500, never enrolment.
 *
 * The gate covers NEW enrolment only: disable, recovery-code regeneration
 * and the sign-in challenge are separate ungated routes, so an enrolled
 * user keeps full management even when `mfa` is denied.
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
  const authenticate = deps.authenticate ?? defaultGetSessionUser
  let user: { id: string } | null
  try {
    user = await authenticate(request.headers)
  } catch {
    // Session lookup itself failed: nobody is authenticated. Deny with 401,
    // never a 500, and never reach the entitlement (no feature-denial log).
    user = null
  }
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const featureCheck = deps.featureCheck ?? ((feature: string) => canForCurrentWorkspace(feature))
  if (!(await featureCheck('mfa'))) {
    return NextResponse.json({ error: 'feature_unavailable', code: 'FEATURE_UNAVAILABLE' }, { status: 403 })
  }
  return handleMfaEnrol(request)
}
