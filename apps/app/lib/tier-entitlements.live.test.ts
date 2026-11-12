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
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { ENTITLEMENT_FEATURES, TIER_ENTITLEMENT_SEED, planRank, type EntitlementFeature } from '@hitly/core'
import { tierEntitlements } from '@hitly/db/schema'
import {
  can,
  canForCurrentWorkspace,
  getEntitlementsForWorkspace,
  invalidateTierEntitlementsCache,
} from './tier-entitlements'

process.env.HITLY_TIER_ENTITLEMENTS_TTL_MS = '0'

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
