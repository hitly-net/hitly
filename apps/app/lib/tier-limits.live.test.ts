/**
 * LIVE Postgres: the tier limits helper against the real `tier_limits`
 * table (migration 0018 seeds it). Proves the seed values, the fail-closed
 * policy for removed rows, and the core promise — moving a cap is an UPDATE,
 * not a code change.
 *
 * Only this file mutates tier_limits (each test file runs in its own
 * process); mutations restore the seed row in a finally.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { TIER_LIMIT_SEED } from '@hitly/core'
import { checkQuota, invalidateTierLimitsCache, limit } from './tier-limits'

process.env.HITLY_TIER_LIMITS_TTL_MS ??= '0'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  ['postgres://', 'hitly', ':', 'hitly', '@localhost:5432/', 'hitly'].join('')

let client: pg.Client

async function deleteSeedRow(plan: string, key: string) {
  await client.query('DELETE FROM tier_limits WHERE plan = $1 AND limit_key = $2', [plan, key])
}

async function restoreSeedRow(plan: string, key: string) {
  const value = TIER_LIMIT_SEED[key as keyof typeof TIER_LIMIT_SEED][plan as never] as number | null
  await client.query(
    'INSERT INTO tier_limits (plan, limit_key, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [plan, key, value],
  )
}

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  invalidateTierLimitsCache()
})

after(async () => {
  await client.end()
})

describe('seeded caps (migration 0018)', () => {
  it('matches the published tiers for the headline keys', async () => {
    invalidateTierLimitsCache()
    const cases: Array<[string, string, number | null]> = [
      ['solo', 'decisions_per_month', 300],
      ['pro', 'decisions_per_month', 2500],
      ['solo', 'seats', 2],
      ['pro', 'seats', 3],
      ['solo', 'live_projects', 2],
      ['pro', 'live_projects', 10],
      ['solo', 'api_keys', 2],
      ['pro', 'api_keys', 10],
      ['solo', 'callback_endpoints_per_project', 1],
      ['pro', 'callback_endpoints_per_project', 3],
      ['solo', 'api_rpm', 60],
      ['pro', 'api_rpm', 300],
      ['solo', 'completed_retention_days', 10],
      ['pro', 'completed_retention_days', 30],
    ]
    for (const [plan, key, expected] of cases) {
      const read = await limit({ plan }, key)
      assert.deepEqual(read, { status: 'ok', value: expected }, `${plan}/${key}`)
    }
  })

  it('self-hosted is unlimited for every key', async () => {
    invalidateTierLimitsCache()
    const rows = await client.query(
      "SELECT limit_key, value FROM tier_limits WHERE plan = 'self-hosted'",
    )
    assert.ok(rows.rowCount && rows.rowCount >= 8)
    for (const row of rows.rows) {
      assert.equal(row.value, null, `self-hosted ${row.limit_key} must be NULL`)
      const read = await limit({ plan: 'self-hosted' }, row.limit_key)
      assert.deepEqual(read, { status: 'ok', value: null })
    }
  })
})

describe('fail-closed on the live table', () => {
  it('unknown key denies, one value-free log line', async () => {
    invalidateTierLimitsCache()
    const lines: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '))
    try {
      const read = await limit({ plan: 'solo' }, 'seats_per_plan')
      assert.deepEqual(read, { status: 'denied', reason: 'unknown_key' })
      assert.equal(lines.length, 1, lines.join('\n'))
    } finally {
      console.warn = original
    }
  })

  it('a removed row blocks new use (missing_row deny), restore works', async () => {
    invalidateTierLimitsCache()
    try {
      await deleteSeedRow('solo', 'seats')
      invalidateTierLimitsCache()
      const read = await limit({ plan: 'solo' }, 'seats')
      assert.deepEqual(read, { status: 'denied', reason: 'missing_row' })
      const check = await checkQuota({ plan: 'solo' }, 'seats', 0)
      assert.equal(check.allowed, false)
    } finally {
      await restoreSeedRow('solo', 'seats')
      invalidateTierLimitsCache()
    }
    const read = await limit({ plan: 'solo' }, 'seats')
    assert.deepEqual(read, { status: 'ok', value: 2 })
  })
})

describe('caps are data, not code', () => {
  it('an UPDATE moves the cap; usage checks follow it', async () => {
    invalidateTierLimitsCache()
    try {
      await client.query(
        "UPDATE tier_limits SET value = 301 WHERE plan = 'solo' AND limit_key = 'decisions_per_month'",
      )
      invalidateTierLimitsCache()
      const read = await limit({ plan: 'solo' }, 'decisions_per_month')
      assert.deepEqual(read, { status: 'ok', value: 301 })
      assert.equal((await checkQuota({ plan: 'solo' }, 'decisions_per_month', 300)).allowed, true)
      const at = await checkQuota({ plan: 'solo' }, 'decisions_per_month', 301)
      assert.equal(at.allowed, false)
      if (!at.allowed) assert.equal(at.reason, 'at_limit')
    } finally {
      await client.query(
        "UPDATE tier_limits SET value = 300 WHERE plan = 'solo' AND limit_key = 'decisions_per_month'",
      )
      invalidateTierLimitsCache()
    }
  })

  it('the TTL cache serves stale rows until invalidated', async () => {
    process.env.HITLY_TIER_LIMITS_TTL_MS = '300000'
    invalidateTierLimitsCache()
    try {
      const before = await limit({ plan: 'pro' }, 'live_projects')
      assert.deepEqual(before, { status: 'ok', value: 10 })
      await client.query(
        "UPDATE tier_limits SET value = 11 WHERE plan = 'pro' AND limit_key = 'live_projects'",
      )
      const cached = await limit({ plan: 'pro' }, 'live_projects')
      assert.deepEqual(cached, { status: 'ok', value: 10 }, 'cached read must not see the UPDATE')
      invalidateTierLimitsCache()
      const fresh = await limit({ plan: 'pro' }, 'live_projects')
      assert.deepEqual(fresh, { status: 'ok', value: 11 })
    } finally {
      await client.query(
        "UPDATE tier_limits SET value = 10 WHERE plan = 'pro' AND limit_key = 'live_projects'",
      )
      process.env.HITLY_TIER_LIMITS_TTL_MS = '0'
      invalidateTierLimitsCache()
    }
  })
})
