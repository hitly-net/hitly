/**
 * LIVE Postgres: the tier entitlements helper against the real
 * `tier_entitlements` table (migration 0015 seeds it). Proves the seed
 * rules, the deny-and-log policy, and the core promise — moving a feature
 * between tiers is an UPDATE, not a code change.
 *
 * The helper's map cache is disabled (TTL 0) so every read hits the table.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { ENTITLEMENT_FEATURES, TIER_ENTITLEMENT_SEED, planRank, type EntitlementFeature } from '@hitly/core'
import { passkeys, sessions, tierEntitlements, userMfaChallenges } from '@hitly/db/schema'
import { auth } from './auth'
import { newId } from './ids'
import { MFA_CHALLENGE_COOKIE, shouldShowAuthenticatorSection } from './mfa'
import { encryptUtf8, fromBase32, resolveMfaEncryptionKey, totpCode } from './mfa-crypto'
import {
  handleMfaConfirm,
  handleMfaEnrol,
  hashMfaChallengeToken,
  type MfaRouteDeps,
} from './mfa-route'
import {
  can,
  canForCurrentWorkspace,
  getEntitlementsForWorkspace,
  invalidateTierEntitlementsCache,
} from './tier-entitlements'

process.env.HITLY_TIER_ENTITLEMENTS_TTL_MS = '0'
process.env.HITLY_MAIL_TRANSPORT ??= 'memory'
process.env.HITLY_SIGNUP_ENABLED ??= '1'
process.env.HITLY_MFA_ENCRYPTION_KEY ??= 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:***@localhost:5432/hitly'
const ALL_PLANS: readonly string[] = ['self-hosted', 'solo', 'pro', 'team', 'enterprise']

let client: pg.Client
let db: ReturnType<typeof drizzle>

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.warn = original) }
}

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  // @ts-expect-error - Client vs Pool type mismatch, works at runtime
  db = drizzle(client)
  invalidateTierEntitlementsCache()
})

after(async () => {
  // Restore the seed exactly, whatever a test below changed.
  for (const feature of ENTITLEMENT_FEATURES) {
    await client.query(
      `INSERT INTO tier_entitlements (feature, min_plan) VALUES ($1, $2)
       ON CONFLICT (feature) DO UPDATE SET min_plan = EXCLUDED.min_plan`,
      [feature, TIER_ENTITLEMENT_SEED[feature as EntitlementFeature]],
    )
  }
  await client.query(`DELETE FROM tier_entitlements WHERE feature <> ALL($1::text[])`, [
    [...ENTITLEMENT_FEATURES],
  ])
  invalidateTierEntitlementsCache()
  await client.end()
})

describe('tier entitlements table seed', () => {
  it('contains exactly the registered features at the seeded minimum plans', async () => {
    const rows = await db.select().from(tierEntitlements)
    const seen = new Map(rows.map((row) => [row.feature as string, row.minPlan as string]))
    assert.deepEqual([...seen.keys()].sort(), [...ENTITLEMENT_FEATURES].sort())
    for (const feature of ENTITLEMENT_FEATURES) {
      assert.equal(seen.get(feature), TIER_ENTITLEMENT_SEED[feature], feature)
    }
  })
})

describe('can() against the seeded map', () => {
  it('MFA allows every plan', async () => {
    for (const plan of ALL_PLANS) assert.equal(await can({ plan }, 'mfa'), true, plan)
  })

  for (const feature of ['sso_google', 'sso_slack'] as const) {
    it(`${feature} allows Team and above only`, async () => {
      for (const plan of ALL_PLANS) {
        assert.equal(await can({ plan }, feature), plan === 'team' || plan === 'enterprise', plan)
      }
    })
  }

  for (const feature of ['sso_microsoft', 'sso_github', 'sso_saml', 'sso'] as const) {
    it(`${feature} allows Enterprise only`, async () => {
      for (const plan of ALL_PLANS) {
        assert.equal(await can({ plan }, feature), plan === 'enterprise', plan)
      }
    })
  }

  it('project lifecycle allows every plan', async () => {
    for (const plan of ALL_PLANS) {
      assert.equal(await can({ plan }, 'project_lifecycle'), true, plan)
    }
  })

  it('an unknown feature denies and logs exactly once', async () => {
    const { lines, restore } = captureWarnings()
    try {
      assert.equal(await can({ plan: 'enterprise' }, 'free_limbo'), false)
    } finally {
      restore()
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /unknown feature "free_limbo"/)
    assert.match(lines[0], /denied/)
  })

  it('an unknown plan denies and logs', async () => {
    const { lines, restore } = captureWarnings()
    try {
      assert.equal(await can({ plan: 'limbo' }, 'mfa'), false)
    } finally {
      restore()
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /unknown workspace plan "limbo"/)
  })

  it('a deleted row denies and logs (fail-closed)', async () => {
    await client.query(`DELETE FROM tier_entitlements WHERE feature = 'mfa'`)
    invalidateTierEntitlementsCache()
    const { lines, restore } = captureWarnings()
    try {
      assert.equal(await can({ plan: 'enterprise' }, 'mfa'), false)
    } finally {
      restore()
      await client.query(
        `INSERT INTO tier_entitlements (feature, min_plan) VALUES ('mfa', 'self-hosted')`,
      )
      invalidateTierEntitlementsCache()
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /no entitlement row for "mfa"/)
  })
})

describe('overrides need no code change', () => {
  it('an UPDATE demoting sso_google takes effect on the next read', async () => {
    assert.equal(await can({ plan: 'solo' }, 'sso_google'), false)
    // Exactly the documented operator move:
    await client.query(`UPDATE tier_entitlements SET min_plan = 'solo' WHERE feature = 'sso_google'`)
    invalidateTierEntitlementsCache()
    try {
      assert.equal(await can({ plan: 'solo' }, 'sso_google'), true)
      assert.equal(await can({ plan: 'self-hosted' }, 'sso_google'), false)
    } finally {
      await client.query(`UPDATE tier_entitlements SET min_plan = 'team' WHERE feature = 'sso_google'`)
      invalidateTierEntitlementsCache()
    }
    assert.equal(await can({ plan: 'solo' }, 'sso_google'), false)
  })

  it('an UPDATE promoting mfa to Team revokes it below the new floor', async () => {
    assert.equal(await can({ plan: 'solo' }, 'mfa'), true)
    await client.query(`UPDATE tier_entitlements SET min_plan = 'team' WHERE feature = 'mfa'`)
    invalidateTierEntitlementsCache()
    try {
      assert.equal(await can({ plan: 'solo' }, 'mfa'), false)
      assert.equal(await can({ plan: 'team' }, 'mfa'), true)
    } finally {
      await client.query(`UPDATE tier_entitlements SET min_plan = 'self-hosted' WHERE feature = 'mfa'`)
      invalidateTierEntitlementsCache()
    }
    assert.equal(await can({ plan: 'solo' }, 'mfa'), true)
  })
})

describe('workspace affordances', () => {
  it('getEntitlementsForWorkspace returns every feature at its seed result', async () => {
    const team = await getEntitlementsForWorkspace({ plan: 'team' })
    assert.deepEqual(Object.keys(team).sort(), [...ENTITLEMENT_FEATURES].sort())
    assert.equal(team.mfa, true)
    assert.equal(team.sso_google, true)
    assert.equal(team.sso_slack, true)
    assert.equal(team.sso_github, false)
    assert.equal(team.sso_saml, false)
    assert.equal(team.sso, false)
    assert.equal(team.project_lifecycle, true)

    const enterprise = await getEntitlementsForWorkspace({ plan: 'enterprise' })
    for (const feature of ENTITLEMENT_FEATURES) assert.equal(enterprise[feature], true, feature)
  })

  it('canForCurrentWorkspace evaluates the resolved workspace plan', async () => {
    const solo = await canForCurrentWorkspace('sso_google', {
      resolveWorkspace: async () => ({ plan: 'solo' }),
    })
    assert.equal(solo, false)
    const team = await canForCurrentWorkspace('sso_google', {
      resolveWorkspace: async () => ({ plan: 'team' }),
    })
    assert.equal(team, true)
  })

  it('canForCurrentWorkspace denies (never throws) when the resolver itself fails', async () => {
    const { lines, restore } = captureWarnings()
    try {
      const denied = await canForCurrentWorkspace('mfa', {
        resolveWorkspace: async () => {
          throw new Error('connection failure')
        },
      })
      assert.equal(denied, false)
    } finally {
      restore()
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /workspace lookup failed; denied "mfa"/)
  })
})

describe('GET /api/v1/workspace/entitlements (live map)', () => {
  // Mutant coverage: a route that hardcoded the plan (e.g. always
  // enterprise) fails both the echoed plan and the per-plan map match.
  it('each plan returns exactly its map and follows the caller plan', async () => {
    const { GET } = await import('../app/api/v1/workspace/entitlements/route')
    for (const plan of ALL_PLANS) {
      const res = await GET(undefined, {
        resolveSession: async () => ({ ok: true as const, workspace: { plan } }),
      })
      assert.equal(res.status, 200, plan)
      const body = (await res.json()) as { plan: string; features: Record<string, boolean> }
      assert.equal(body.plan, plan)
      for (const feature of ENTITLEMENT_FEATURES) {
        const expected = planRank(plan) >= planRank(TIER_ENTITLEMENT_SEED[feature])
        assert.equal(body.features[feature], expected, `${plan}/${feature}`)
      }
    }
  })
})

describe('project lifecycle follows the map, not hardcoded true', () => {
  // Mutant coverage: canUseProjectLifecycle hardcoded to `return true`
  // fails the demoted-plan assertion.
  it('demoting project_lifecycle in the table gates pause/archive', async () => {
    const { canUseProjectLifecycle } = await import('./project-lifecycle')
    assert.equal(await canUseProjectLifecycle({ id: 'wsp-mut', plan: 'solo' }), true)
    await client.query(
      `UPDATE tier_entitlements SET min_plan = 'enterprise' WHERE feature = 'project_lifecycle'`,
    )
    invalidateTierEntitlementsCache()
    try {
      assert.equal(await canUseProjectLifecycle({ id: 'wsp-mut', plan: 'solo' }), false)
      assert.equal(await canUseProjectLifecycle({ id: 'wsp-mut', plan: 'team' }), false)
      assert.equal(await canUseProjectLifecycle({ id: 'wsp-mut', plan: 'enterprise' }), true)
    } finally {
      await client.query(
        `UPDATE tier_entitlements SET min_plan = 'self-hosted' WHERE feature = 'project_lifecycle'`,
      )
      invalidateTierEntitlementsCache()
    }
    assert.equal(await canUseProjectLifecycle({ id: 'wsp-mut', plan: 'solo' }), true)
  })
})

describe('cache TTL (S4): the map expires on its own', () => {
  // Mutant coverage: a cache that never expires (or treats blank/invalid
  // as cache-off) fails — the update would be visible immediately, or the
  // post-expiry read would still be cached-allowed.
  it('an UPDATE becomes visible after the TTL without any invalidation', async () => {
    process.env.HITLY_TIER_ENTITLEMENTS_TTL_MS = '50'
    invalidateTierEntitlementsCache()
    await client.query(`UPDATE tier_entitlements SET min_plan = 'self-hosted' WHERE feature = 'mfa'`)
    assert.equal(await can({ plan: 'solo' }, 'mfa'), true) // primes the 50ms cache
    await client.query(`UPDATE tier_entitlements SET min_plan = 'enterprise' WHERE feature = 'mfa'`)
    try {
      assert.equal(await can({ plan: 'solo' }, 'mfa'), true, 'fresh cache must still serve the old map')
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(await can({ plan: 'solo' }, 'mfa'), false, 'expired cache must re-read the table')
    } finally {
      await client.query(`UPDATE tier_entitlements SET min_plan = 'self-hosted' WHERE feature = 'mfa'`)
      process.env.HITLY_TIER_ENTITLEMENTS_TTL_MS = '0'
      invalidateTierEntitlementsCache()
    }
  })
})

describe('existing MFA stays fully manageable while mfa is denied (S2/S-D)', () => {
  // Real user, real better-auth session, real MFA factor, real passkey row.
  // The map then DENIES `mfa` for the user's plan; every management path
  // must still work (S-D: behavioural, through the real disable route).
  // Mutant coverage: gating the disable route (or any management path)
  // fails this suite while the row denies. Page visibility of the enrolled
  // section is covered by app/settings/security/page.test.tsx (N1), not here.
  const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
  const PASSWORD = 'correct-horse-battery'
  const NOW = 1_700_000_300_000
  const STEP_MS = 30_000
  const runId = newId('t').slice(-8)

  function post(endpoint: string, cookie: string | undefined, body: unknown): Request {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      origin: APP_URL,
    }
    if (cookie) headers.cookie = cookie
    return new Request(`${APP_URL}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never
  }

  function handlerDeps(steps: number, overrides: Partial<MfaRouteDeps> = {}): MfaRouteDeps {
    return {
      log: () => {},
      now: () => NOW + steps * STEP_MS,
      allowReauth: () => true,
      allowVerify: () => true,
      ...overrides,
    }
  }

  it('disable, regenerate, challenge and passkey removal all survive a denial', async () => {
    assert.ok(auth, 'live test needs better-auth')
    const address = `hg3-s2-${runId}@example.com`
    await auth!.api.signUpEmail({ body: { email: address, name: 'S2', password: PASSWORD } })
    const { headers } = await auth!.api.signInEmail({
      body: { email: address, password: PASSWORD },
      returnHeaders: true,
    })
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')

    // Enrol and confirm for real (MFA becomes active).
    const enrolled = await handleMfaEnrol(
      post('/api/session/mfa/enrol', cookie, { currentPassword: PASSWORD }),
      handlerDeps(0),
    )
    assert.equal(enrolled.status, 200)
    const { secret } = (await enrolled.json()) as { secret: string }
    const confirmed = await handleMfaConfirm(
      post('/api/session/mfa/confirm', cookie, { code: totpCode(fromBase32(secret), NOW) }),
      handlerDeps(0),
    )
    assert.equal(confirmed.status, 200)

    // The user's plan workspace; the map now DENIES mfa for it.
    const workspace = { plan: 'solo' }
    await client.query(`UPDATE tier_entitlements SET min_plan = 'enterprise' WHERE feature = 'mfa'`)
    invalidateTierEntitlementsCache()
    try {
      assert.equal(await can(workspace, 'mfa'), false, 'precondition: the map denies mfa')
      const { getMfaStatus } = await import('./mfa-route')
      const userQ = await client.query(`SELECT id FROM users WHERE email = $1`, [address.toLowerCase()])
      const userId = userQ.rows[0]?.id as string | undefined
      assert.ok(userId, 'created user must exist')
      const status = await getMfaStatus(userId)
      assert.equal(status.enabled, true)
      assert.equal(shouldShowAuthenticatorSection(status, false), true)

      // Regenerate recovery codes while denied — through the REAL route
      // (M2): copying the enrol gate onto this route fails here. The route
      // runs handleMfaRecoveryCodes with the real clock, so the TOTP code is
      // generated at the actual current time.
      const { POST: recoveryCodesRoute } = await import('../app/api/session/mfa/recovery-codes/route')
      const regen = await recoveryCodesRoute(
        post('/api/session/mfa/recovery-codes', cookie, {
          currentPassword: PASSWORD,
          code: totpCode(fromBase32(secret), Date.now()),
        }) as never,
      )
      assert.equal(regen.status, 200)
      const regenBody = (await regen.json()) as { recoveryCodes?: string[] }
      assert.ok(Array.isArray(regenBody.recoveryCodes) && regenBody.recoveryCodes.length >= 5)

      // The existing sign-in challenge still fires (and completes).
      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, userId))
      assert.ok(sessionRows.length >= 1, 'user must have a session')
      const token = randomBytes(32).toString('hex')
      const key = resolveMfaEncryptionKey()
      await db.insert(userMfaChallenges).values({
        id: newId('mfac').slice(0, 36),
        userId,
        tokenHash: hashMfaChallengeToken(token),
        sessionId: sessionRows[0].id,
        cookiesCiphertext: encryptUtf8(JSON.stringify({ setCookies: ['held=1; Path=/; HttpOnly'] }), key),
        // The verify route runs on the real clock, so the challenge must be
        // valid at the actual current time.
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
      // The REAL verify route (M2): copying the enrol gate onto it fails
      // here. The code sits one step ahead of real now so it clears the
      // replay guard set by the regen above.
      const { POST: verifyRoute } = await import('../app/api/session/mfa/verify/route')
      const verified = await verifyRoute(
        post('/api/session/mfa/verify', `${MFA_CHALLENGE_COOKIE}=${token}`, {
          code: totpCode(fromBase32(secret), Date.now() + STEP_MS),
        }) as never,
      )
      assert.equal(verified.status, 200, 'the challenge must still complete while denied')
      assert.deepEqual((await verified.json()), { ok: true })

      // Removing a passkey works while denied (never gated at all).
      const passkeyId = newId('pk').slice(0, 36)
      await db.insert(passkeys).values({
        id: passkeyId,
        name: 's2-test-key',
        publicKey: 'test-public-key',
        userId,
        credentialID: `cred-${runId}`,
        counter: 0,
        deviceType: 'platform',
        backedUp: false,
      })
      // Removing a passkey works while denied — through the REAL route
      // (M2): copying the enrol gate onto it fails here.
      const { POST: passkeyDeleteRoute } = await import('../app/api/session/passkey/[id]/delete/route')
      const removed = await passkeyDeleteRoute(
        post(`/api/session/passkey/${passkeyId}/delete`, cookie, { currentPassword: PASSWORD }) as never,
        { params: Promise.resolve({ id: passkeyId }) },
      )
      assert.equal(removed.status, 200)
      assert.deepEqual((await removed.json()), { ok: true })
      const leftover = await db.select().from(passkeys).where(eq(passkeys.id, passkeyId))
      assert.equal(leftover.length, 0)

      // Disable MFA last, still denied — through the REAL route wrapper
      // (S-D): an added gate inside the disable route fails here. The
      // current TOTP steps are consumed by the regen and verify above, so
      // this re-auth presents a freshly generated recovery code instead.
      const { POST: disableRoute } = await import('../app/api/session/mfa/disable/route')
      const disabled = await disableRoute(
        post('/api/session/mfa/disable', cookie, {
          currentPassword: PASSWORD,
          code: regenBody.recoveryCodes[0],
        }) as never,
      )
      assert.equal(disabled.status, 200, 'disable must work while denied')
      assert.equal((await getMfaStatus(userId)).enabled, false)
    } finally {
      await client.query(`UPDATE tier_entitlements SET min_plan = 'self-hosted' WHERE feature = 'mfa'`)
      invalidateTierEntitlementsCache()
    }
  })
})

describe('password sign-in is still held for the MFA challenge while mfa is denied (N2)', () => {
  // Real better-auth user with MFA enabled, driven through the REAL sign-in
  // path (catch-all auth route composition + holdPasswordSignInIfMfa).
  // While the map denies `mfa` for the plan, password sign-in must still
  // return {mfaRequired:true} + the challenge cookie and NO session.
  // Mutant G8 (skip the MFA hold when the entitlement denies) fails here:
  // the raw sign-in response would carry the session, not mfaRequired.
  const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
  const PASSWORD = 'correct-horse-battery'
  const NOW = 1_700_000_600_000
  const STEP_MS = 30_000
  const runId = newId('t').slice(-8)

  function post(endpoint: string, cookie: string | undefined, body: unknown): Request {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      origin: APP_URL,
    }
    if (cookie) headers.cookie = cookie
    return new Request(`${APP_URL}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never
  }

  async function deniedSignInHolds(address: string, mode: 'demote' | 'delete'): Promise<void> {
    assert.ok(auth, 'live test needs better-auth')
    const authInstance = auth
    await authInstance.api.signUpEmail({ body: { email: address, name: 'N2', password: PASSWORD } })
    const { headers } = await authInstance.api.signInEmail({
      body: { email: address, password: PASSWORD },
      returnHeaders: true,
    })
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')

    // Enrol and confirm for real (MFA becomes active).
    const deps: MfaRouteDeps = {
      log: () => {},
      now: () => NOW,
      allowReauth: () => true,
      allowVerify: () => true,
    }
    const enrolled = await handleMfaEnrol(
      post('/api/session/mfa/enrol', cookie, { currentPassword: PASSWORD }),
      deps,
    )
    assert.equal(enrolled.status, 200, await enrolled.clone().text())
    const { secret } = (await enrolled.json()) as { secret: string }
    const confirmed = await handleMfaConfirm(
      post('/api/session/mfa/confirm', cookie, { code: totpCode(fromBase32(secret), NOW) }),
      deps,
    )
    assert.equal(confirmed.status, 200, await confirmed.clone().text())

    // The map now DENIES mfa for the plan, either by demotion or deletion.
    if (mode === 'demote') {
      await client.query(`UPDATE tier_entitlements SET min_plan = 'enterprise' WHERE feature = 'mfa'`)
    } else {
      await client.query(`DELETE FROM tier_entitlements WHERE feature = 'mfa'`)
    }
    invalidateTierEntitlementsCache()
    try {
      assert.equal(await can({ plan: 'solo' }, 'mfa'), false, 'precondition: the map denies mfa')
      const request = new Request(`${APP_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_URL },
        body: JSON.stringify({ email: address, password: PASSWORD }),
      })
      // The REAL catch-all route POST (toNextJsHandler + handleAuthRequest +
      // holdPasswordSignInIfMfa) — a hold-skip inside that POST (mutant G8r)
      // returns the un-held response and fails the assertions below.
      const { POST: authRoutePost } = await import('../app/api/auth/[...all]/route')
      const held = await authRoutePost(request as never)
      assert.equal(held.status, 200)
      assert.deepEqual(await held.json(), { mfaRequired: true })
      const cookies = held.headers.getSetCookie()
      assert.ok(
        cookies.some((entry) => entry.startsWith(`${MFA_CHALLENGE_COOKIE}=`)),
        'challenge cookie must be issued while the entitlement denies',
      )
      assert.ok(
        !cookies.some((entry) => /^better-auth\.session_token=[^;]/.test(entry)),
        'the held response must not carry a session cookie',
      )
      // And the challenge cookie alone must not authenticate.
      const heldCookie = cookies.map((entry) => entry.split(';')[0]).join('; ')
      const session = await authInstance.api.getSession({
        headers: new Headers({ cookie: heldCookie, origin: APP_URL }),
      })
      assert.equal(session, null, 'no session may exist while the sign-in is held')
    } finally {
      await client.query(
        `INSERT INTO tier_entitlements (feature, min_plan) VALUES ('mfa', 'self-hosted')
         ON CONFLICT (feature) DO UPDATE SET min_plan = EXCLUDED.min_plan`,
      )
      invalidateTierEntitlementsCache()
    }
  }

  it('holds the challenge with the mfa row demoted above the plan', async () => {
    await deniedSignInHolds(`hg3-n2-demote-${runId}@example.com`, 'demote')
  })

  it('holds the challenge with the mfa row deleted', async () => {
    await deniedSignInHolds(`hg3-n2-delete-${runId}@example.com`, 'delete')
  })
})
