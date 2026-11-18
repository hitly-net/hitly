/**
 * Tier limits helper, no-database half: pure resolver + fail-closed policy.
 *
 * DATABASE_URL is deleted before the module loads (each test file runs in
 * its own process), so the shared `db` singleton is null — the exact state
 * of a misconfigured server. Everything must block, with one value-free log
 * line each. The pure resolver and the seed are checked directly too: the
 * migration mirrors TIER_LIMIT_SEED, so the seed must be complete.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TIER_LIMIT_KEYS, TIER_LIMIT_SEED, buildLimitsMap, limitFromMap, withinLimit } from '@hitly/core'

delete process.env.DATABASE_URL

type Helper = typeof import('./tier-limits')

async function helper(): Promise<Helper> {
  return import('./tier-limits')
}

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.warn = original) }
}

const ALL_PLANS: readonly string[] = ['self-hosted', 'solo', 'pro', 'team', 'enterprise']

describe('pure resolver', () => {
  const map = buildLimitsMap([
    { plan: 'solo', limitKey: 'api_rpm', value: 60 },
    { plan: 'pro', limitKey: 'api_rpm', value: null },
    // self-hosted present with NULL caps (like the real seed): an unknown
    // plan must still deny — silently falling back to self-hosted (all
    // unlimited) is the worst possible bug here, so it must be observable.
    { plan: 'self-hosted', limitKey: 'api_rpm', value: null },
    { plan: 'self-hosted', limitKey: 'seats', value: null },
  ])

  it('returns the configured cap', () => {
    assert.deepEqual(limitFromMap(map, { plan: 'solo' }, 'api_rpm'), { status: 'ok', value: 60 })
  })

  it('NULL means unlimited', () => {
    assert.deepEqual(limitFromMap(map, { plan: 'pro' }, 'api_rpm'), { status: 'ok', value: null })
  })

  it('denies unknown keys', () => {
    assert.deepEqual(limitFromMap(map, { plan: 'solo' }, 'rocket_chairs'), {
      status: 'denied',
      reason: 'unknown_key',
    })
  })

  it('denies unknown plans (fail-closed)', () => {
    assert.deepEqual(limitFromMap(map, { plan: 'wizard' }, 'api_rpm'), {
      status: 'denied',
      reason: 'unknown_plan',
    })
  })

  it('denies missing rows (fail-closed)', () => {
    assert.deepEqual(limitFromMap(map, { plan: 'solo' }, 'seats'), {
      status: 'denied',
      reason: 'missing_row',
    })
  })

  it('withinLimit: deny blocks like a cap of zero', () => {
    assert.equal(withinLimit({ status: 'denied', reason: 'missing_row' }, 0), false)
  })

  it('withinLimit: unlimited always allows', () => {
    assert.equal(withinLimit({ status: 'ok', value: null }, 9_999_999), true)
  })

  it('withinLimit: usage below the cap allows, at or above blocks', () => {
    assert.equal(withinLimit({ status: 'ok', value: 60 }, 59), true)
    assert.equal(withinLimit({ status: 'ok', value: 60 }, 60), false)
    assert.equal(withinLimit({ status: 'ok', value: 60 }, 61), false)
  })
})

describe('seed completeness (the migration mirrors this)', () => {
  it('every registered key has an entry for every plan', () => {
    for (const key of TIER_LIMIT_KEYS) {
      const perPlan = TIER_LIMIT_SEED[key]
      assert.ok(perPlan, `seed missing key ${key}`)
      for (const plan of ALL_PLANS) {
        const value = perPlan[plan as keyof typeof perPlan]
        assert.ok(
          value === null || (Number.isInteger(value) && value > 0),
          `seed ${key}/${plan} must be a positive integer or null, got ${String(value)}`,
        )
      }
    }
  })

  it('self-hosted is unlimited everywhere (OSS is never capped)', () => {
    for (const key of TIER_LIMIT_KEYS) {
      for (const plan of ALL_PLANS) {
        if (plan === 'self-hosted') {
          assert.equal(TIER_LIMIT_SEED[key]['self-hosted'], null, `self-hosted ${key} must be NULL`)
        }
      }
    }
  })
})

describe('no database (fail-closed)', () => {
  it('limit() blocks with one value-free log line', async () => {
    const h = await helper()
    h.invalidateTierLimitsCache()
    const cap = captureWarnings()
    try {
      const read = await h.limit({ plan: 'solo' }, 'api_rpm')
      assert.equal(read.status, 'denied')
      assert.equal(cap.lines.length, 1, cap.lines.join('\n'))
      assert.match(cap.lines[0], /\[hitly tier limits\]/)
      assert.doesNotMatch(cap.lines[0], /60/)
    } finally {
      cap.restore()
    }
  })

  it('checkQuota blocks like a cap of zero when the map is unavailable', async () => {
    const h = await helper()
    h.invalidateTierLimitsCache()
    const cap = captureWarnings()
    try {
      const check = await h.checkQuota({ plan: 'solo' }, 'decisions_per_month', 0)
      assert.equal(check.allowed, false)
      if (!check.allowed) assert.equal(check.limit, 0)
    } finally {
      cap.restore()
    }
  })

  it('limitForCurrentWorkspace blocks when workspace lookup throws', async () => {
    const h = await helper()
    const cap = captureWarnings()
    try {
      const read = await h.limitForCurrentWorkspace('api_rpm', {
        resolveWorkspace: async () => {
          throw new Error('session backend down')
        },
      })
      assert.equal(read.status, 'denied')
      assert.ok(cap.lines.some((line) => line.includes('workspace lookup failed')))
    } finally {
      cap.restore()
    }
  })

  it('limitForCurrentWorkspace blocks when there is no current workspace', async () => {
    const h = await helper()
    const cap = captureWarnings()
    try {
      const read = await h.limitForCurrentWorkspace('api_rpm', {
        resolveWorkspace: async () => null,
      })
      assert.equal(read.status, 'denied')
      assert.ok(cap.lines.some((line) => line.includes('no current workspace')))
    } finally {
      cap.restore()
    }
  })
})
