/**
 * LIVE Postgres, own process and own throwaway database: fail-closed proof
 * for the tier-limits read path. The table exists here — the failures are
 * injected (table renamed away = connection-query error) so the catch path,
 * the no-cache-on-failure rule and the unknown-plan deny are all exercised
 * against a real pool, not by deleting DATABASE_URL.
 *
 * Pinned behaviour (each line fails if the helper ever "helpfully" falls
 * back or caches a failure):
 *  - a query error returns a deny with reason 'database_unavailable' — it
 *    never throws, and never returns unlimited;
 *  - failures are never cached: once the table is back the very next read
 *    succeeds without any cache poke;
 *  - an unknown plan denies — it never falls back to another plan's row set
 *    (above all not to 'self-hosted', whose caps are all NULL = unlimited);
 *  - the seed INSERT is replayable (ON CONFLICT DO NOTHING) and the plan
 *    CHECK rejects an unknown plan at the database level.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import path from 'node:path'
import pg from 'pg'

const BASE_URL = process.env.DATABASE_URL ?? ['postgres://***:***@localhost:5432/','hitly'].join('')
const REPO_ROOT = path.join(__dirname, '../../..')
const DB = 'hitly_tier_limits_dberror'

function urlWithDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

const TARGET_URL = urlWithDatabase(BASE_URL, DB)

let client: pg.Client
let limit: (workspace: { plan: string }, key: string) => Promise<{ status: string; value?: number | null; reason?: string }>
let checkQuota: (
  workspace: { plan: string },
  key: string,
  usage: number,
) => Promise<{ allowed: boolean; limit: number | null; reason?: string }>
let invalidate: () => void

before(async () => {
  const admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`)
  await admin.query(`CREATE DATABASE ${DB}`)
  await admin.end()

  execFileSync('yarn', ['workspace', '@hitly/db', 'db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: TARGET_URL },
    stdio: 'pipe',
    timeout: 120_000,
  })

  // Cache ON (long TTL) BEFORE importing the helper: the no-cache-on-failure
  // rule must hold even when a successful read would be cached for minutes.
  process.env.HITLY_TIER_LIMITS_TTL_MS = '300000'
  process.env.DATABASE_URL = TARGET_URL
  const helper = await import('./tier-limits')
  limit = helper.limit
  checkQuota = helper.checkQuota
  invalidate = helper.invalidateTierLimitsCache

  client = new pg.Client({ connectionString: TARGET_URL })
  await client.connect()
})

after(async () => {
  await client?.end().catch(() => undefined)
  try {
    const { pool } = await import('./db')
    await pool?.end()
  } catch {
    // pool already gone
  }
  const admin = new pg.Client({ connectionString: BASE_URL })
  try {
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
  } catch {
    // best-effort; the next run drops-if-exists first
  } finally {
    await admin.end().catch(() => undefined)
  }
})

test('query error denies with database_unavailable, never throws, never unlimited; failure is not cached', async () => {
  invalidate()
  await client.query('ALTER TABLE tier_limits RENAME TO tier_limits_hidden')
  try {
    const r = await limit({ plan: 'pro' }, 'seats')
    assert.equal(r.status, 'denied', `query error must deny, got ${JSON.stringify(r)}`)
    assert.equal(r.reason, 'database_unavailable')
    const q = await checkQuota({ plan: 'pro' }, 'seats', 0)
    assert.equal(q.allowed, false, 'checkQuota must block on a query error')
  } finally {
    await client.query('ALTER TABLE tier_limits_hidden RENAME TO tier_limits')
  }
  // No invalidate(): a cached failure (or a cached "unlimited") would keep
  // denying here; a healthy read must come back immediately.
  const ok = await limit({ plan: 'pro' }, 'seats')
  assert.equal(ok.status, 'ok', `read must recover without poking the cache, got ${JSON.stringify(ok)}`)
  assert.equal(ok.value, 3)
})

test('unknown plan denies — never falls back to another plan, above all not self-hosted', async () => {
  invalidate()
  // Sanity: the same key on a known plan is capped (3 seats for pro).
  const known = await limit({ plan: 'pro' }, 'seats')
  assert.deepEqual({ status: known.status, value: known.value }, { status: 'ok', value: 3 })

  const r = await limit({ plan: 'no-such-plan' }, 'seats')
  assert.equal(r.status, 'denied', `unknown plan must deny, got ${JSON.stringify(r)}`)
  assert.equal(r.reason, 'unknown_plan')
  const q = await checkQuota({ plan: 'no-such-plan' }, 'api_keys', 0)
  assert.equal(q.allowed, false)
  assert.equal(q.reason, 'unknown_plan')
})

test('seed replay is a no-op (ON CONFLICT) and the plan CHECK rejects unknown plans', async () => {
  const before = await client.query(
    "SELECT value FROM tier_limits WHERE plan = 'solo' AND limit_key = 'api_rpm'",
  )
  assert.equal(before.rows[0].value, 60)
  // A different value for the SAME (plan, key) must not overwrite (the
  // migration seed is replayable; an operator fix survives re-running it).
  await client.query(
    "INSERT INTO tier_limits (plan, limit_key, value) VALUES ('solo', 'api_rpm', 999) ON CONFLICT DO NOTHING",
  )
  const afterConflict = await client.query(
    "SELECT value FROM tier_limits WHERE plan = 'solo' AND limit_key = 'api_rpm'",
  )
  assert.equal(afterConflict.rows[0].value, 60, 'ON CONFLICT DO NOTHING must not overwrite')
  await assert.rejects(
    client.query("INSERT INTO tier_limits (plan, limit_key, value) VALUES ('wizard', 'seats', 1)"),
    /violates check constraint|check constraint/i,
  )
})
