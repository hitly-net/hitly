import { NextRequest, NextResponse } from 'next/server'
import { handleMfaEnrol } from '@/lib/mfa-route'
import { canForCurrentWorkspace } from '@/lib/tier-entitlements'
import { isJsonContentType, isSameOrigin } from '../../sign-out/route'

/**
 * Start authenticator-app MFA enrolment (POST /api/session/mfa/enrol).
 * Requires a current-password check. MFA stays inactive until confirm.
 *
 * Tier gate: the `mfa` feature (tier_entitlements map, seeded for every
 * plan) is checked against the session's current workspace before any
 * enrolment state is created.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get('origin'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
  }
  if (!(await canForCurrentWorkspace('mfa'))) {
    return NextResponse.json({ error: 'feature_unavailable', code: 'FEATURE_UNAVAILABLE' }, { status: 403 })
  }
  return handleMfaEnrol(request)
}
