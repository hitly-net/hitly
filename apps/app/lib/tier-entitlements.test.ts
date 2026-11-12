/**
 * Tier entitlements helper, no-database half: fail-closed behaviour.
 *
 * DATABASE_URL is deleted before the module loads (each test file runs in
 * its own process), so the shared `db` singleton is null — the exact state
 * of a misconfigured server. Everything must deny, with one value-free log
 * line each.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NextResponse } from 'next/server'

delete process.env.DATABASE_URL

type Helper = typeof import('./tier-entitlements')

async function helper(): Promise<Helper> {
  return import('./tier-entitlements')
}

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.warn = original) }
}

describe('tier entitlements fail-closed without a database', () => {
  it('can() denies every feature and logs once', async () => {
    const { can } = await helper()
    const { lines, restore } = captureWarnings()
    try {
      assert.equal(await can({ plan: 'enterprise' }, 'mfa'), false)
      assert.equal(await can({ plan: 'enterprise' }, 'sso_google'), false)
      assert.equal(await can({ plan: 'enterprise' }, 'not_a_feature'), false)
    } finally {
      restore()
    }
    assert.equal(lines.length, 3)
    for (const line of lines) {
      assert.match(line, /\[hitly entitlements\]/)
      assert.match(line, /database unavailable/)
    }
  })

  it('canForCurrentWorkspace denies when there is no current workspace and logs once', async () => {
    const { canForCurrentWorkspace } = await helper()
    const { lines, restore } = captureWarnings()
    try {
      const denied = await canForCurrentWorkspace('mfa', {
        resolveWorkspace: async () => null,
      })
      assert.equal(denied, false)
    } finally {
      restore()
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /no current workspace; denied "mfa"/)
  })

  it('getEntitlementsForWorkspace denies everything without a database', async () => {
    const { getEntitlementsForWorkspace } = await helper()
    const { restore } = captureWarnings()
    try {
      const features = await getEntitlementsForWorkspace({ plan: 'enterprise' })
      for (const value of Object.values(features)) assert.equal(value, false)
      assert.ok(Object.keys(features).length >= 8)
    } finally {
      restore()
    }
  })
})

/* ---------------------------------------------------------------------
 * Route-level gate tests (M1/M2): the real route handlers run; only the
 * tier gate and the session resolver are stubbed via the deps seams.
 * ------------------------------------------------------------------- */

const APP_ORIGIN = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

function enrolRequest(): Request {
  return new Request(`${APP_ORIGIN}/api/session/mfa/enrol`, {
    method: 'POST',
    headers: { origin: APP_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'x' }),
  })
}

describe('POST /api/session/mfa/enrol gates on the mfa feature (server-side)', () => {
  // Mutant coverage: removing the gate (or letting enrolment through when
  // the gate denies) fails the deny test; checking the wrong feature name
  // fails the `asked` assertion.
  it('denies with 403 FEATURE_UNAVAILABLE and asks the gate for exactly "mfa"', async () => {
    const { POST } = await import('../app/api/session/mfa/enrol/route')
    const asked: string[] = []
    const res = await POST(enrolRequest() as never, {
      featureCheck: async (feature: string) => {
        asked.push(feature)
        return false
      },
    })
    assert.equal(res.status, 403)
    assert.deepEqual((await res.json()).code, 'FEATURE_UNAVAILABLE')
    assert.deepEqual(asked, ['mfa'])
  })

  it('does not reach enrolment when the gate denies, and asks exactly once', async () => {
    const { POST } = await import('../app/api/session/mfa/enrol/route')
    let calls = 0
    const res = await POST(enrolRequest() as never, {
      featureCheck: async () => {
        calls += 1
        return false
      },
    })
    assert.equal(res.status, 403)
    assert.equal(calls, 1)
  })

  it('passes the gate through to enrolment when allowed (no 403 tier answer)', async () => {
    const { POST } = await import('../app/api/session/mfa/enrol/route')
    const asked: string[] = []
    const res = await POST(enrolRequest() as never, {
      featureCheck: async (feature: string) => {
        asked.push(feature)
        return true
      },
    })
    assert.deepEqual(asked, ['mfa'])
    const body = (await res.json().catch(() => null)) as { code?: string } | null
    assert.notEqual(body?.code, 'FEATURE_UNAVAILABLE')
    assert.notEqual(res.status, 403)
  })

  it('answers 403 (never 500) on the default gate path with no database', async () => {
    const { POST } = await import('../app/api/session/mfa/enrol/route')
    const { restore } = captureWarnings()
    try {
      const res = await POST(enrolRequest() as never)
      assert.equal(res.status, 403)
      assert.deepEqual((await res.json()).code, 'FEATURE_UNAVAILABLE')
    } finally {
      restore()
    }
  })
})

describe('GET /api/v1/workspace/entitlements', () => {
  // Mutant coverage: dropping the auth short-circuit yields 404/throw, not 401.
  it('signed-out request is 401 and the map is never evaluated', async () => {
    const { GET } = await import('../app/api/v1/workspace/entitlements/route')
    const res = await GET(undefined, {
      resolveSession: async () => ({
        ok: false as const,
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      }),
      entitlements: async () => {
        throw new Error('must not evaluate the map for a signed-out caller')
      },
    })
    assert.equal(res.status, 401)
  })

  it('session without a workspace is 404', async () => {
    const { GET } = await import('../app/api/v1/workspace/entitlements/route')
    const res = await GET(undefined, {
      resolveSession: async () => ({ ok: true as const, workspace: null }),
    })
    assert.equal(res.status, 404)
  })

  it('answers with the CALLER plan and exactly that plan’s map', async () => {
    const { GET } = await import('../app/api/v1/workspace/entitlements/route')
    const seen: string[] = []
    const mapFor = { mfa: true, sso_google: false }
    const res = await GET(undefined, {
      resolveSession: async () => ({ ok: true as const, workspace: { plan: 'solo' } }),
      entitlements: async (workspace: { plan: string }) => {
        seen.push(workspace.plan)
        return mapFor
      },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    // Mutant coverage: a route hardcoding any plan (e.g. enterprise) fails
    // both the echoed plan and the plan handed to the map evaluator.
    assert.equal(body.plan, 'solo')
    assert.deepEqual(seen, ['solo'])
    assert.deepEqual(body.features, mapFor)
  })

  it('default session path with no database is a 401/503 denial, never 500', async () => {
    const { GET } = await import('../app/api/v1/workspace/entitlements/route')
    const { restore } = captureWarnings()
    try {
      const res = await GET()
      assert.ok(res.status === 401 || res.status === 503 || res.status === 404, `got ${res.status}`)
    } finally {
      restore()
    }
  })
})
