/**
 * LIVE shared-database rate limiter tests (real Postgres, same harness as the
 * other *.live tests). They pin the properties that make the limiter
 * "shared": two limiter instances pointed at one database enforce ONE
 * counter, windows reset after expiry, expired rows are swept, subjects are
 * stored only as hashes, and a broken database degrades to per-process
 * counting with exactly one log line (never a hard failure, never a bypass
 * of the local budget).
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import {
  createSharedRateLimiter,
  rateLimitBucketKey,
  rateLimitRuleFromEnv,
  type RateLimitQueryable,
} from '@hitly/db/rate-limit'
import { createAuthRateLimitStorage } from './rate-limit'
import { newId } from './ids'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required for these tests')
const pool = new pg.Pool({ connectionString: url, max: 3 })
after(async () => {
  await pool.end()
})

const run = newId('rl').slice(-10)
const subjects: string[] = []

/** A route name unique to this run, so buckets never collide with anything else. */
function route(name: string): string {
  return `t-${run}-${name}`.slice(0, 64)
}

async function rowsFor(routeName: string): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query('SELECT bucket_key, route, count, window_start, expires_at FROM rate_limit_buckets WHERE route = $1', [routeName])
  return result.rows as Array<Record<string, unknown>>
}

describe('shared rate limiter (live Postgres)', () => {
  it('two limiter instances sharing the database enforce one counter', async () => {
    const routeName = route('shared')
    const subject = `client-${run}`
    subjects.push(subject)
    let now = Date.now()
    const clock = () => now
    const a = createSharedRateLimiter({ pool, now: clock })
    const b = createSharedRateLimiter({ pool, now: clock })
    const rule = { limit: 5, windowMs: 60_000 }

    const results: boolean[] = []
    for (let i = 0; i < 5; i += 1) {
      const limiter = i % 2 === 0 ? a : b
      results.push((await limiter.acquire(routeName, subject, rule)).allowed)
    }
    assert.ok(results.every(Boolean), 'the shared budget allows exactly `limit` requests across instances')
    const denied = await b.acquire(routeName, subject, rule)
    assert.equal(denied.allowed, false, 'the sixth request across the two instances is refused')
    assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000, `denied requests carry a usable Retry-After, got ${String(denied.retryAfterMs)}`)

    // Window reset: once the window passes, both instances allow again.
    now += 60_001
    const revived = await a.acquire(routeName, subject, rule)
    assert.equal(revived.allowed, true, 'the window reset gives a fresh budget')
    assert.equal(revived.count, 1, 'the new window starts at one')
  })

  it('keys per route: the same subject on another route has its own budget', async () => {
    const subject = `multi-${run}`
    subjects.push(subject)
    const rule = { limit: 1, windowMs: 60_000 }
    const limiter = createSharedRateLimiter({ pool })
    assert.equal((await limiter.acquire(route('a'), subject, rule)).allowed, true)
    assert.equal((await limiter.acquire(route('b'), subject, rule)).allowed, true, 'route names separate the buckets')
    assert.equal((await limiter.acquire(route('a'), subject, rule)).allowed, false)
  })

  it('stores only hashes: no raw subject lands in the table', async () => {
    const routeName = route('hash')
    const secret = `secret-${run}@example.com`
    const limiter = createSharedRateLimiter({ pool })
    await limiter.acquire(routeName, secret, { limit: 3, windowMs: 60_000 })
    const rows = await rowsFor(routeName)
    assert.equal(rows.length, 1)
    const row = rows[0]!
    assert.equal(row.bucket_key, rateLimitBucketKey(routeName, secret))
    assert.equal(String(row.bucket_key).length, 64)
    assert.ok(!/example/.test(JSON.stringify(rows)), 'the raw subject is nowhere in the stored row')
    const scan = await pool.query('SELECT bucket_key FROM rate_limit_buckets WHERE bucket_key = $1', [secret])
    assert.equal((scan.rows as unknown[]).length, 0, 'a raw-subject lookup can never match')
  })

  it('sweeps expired buckets', async () => {
    const routeName = route('sweep')
    const limiter = createSharedRateLimiter({ pool })
    for (const name of ['x', 'y', 'z']) await limiter.acquire(routeName, `${name}-${run}`, { limit: 2, windowMs: 60_000 })
    assert.equal((await rowsFor(routeName)).length, 3)
    // Backdate every row's window into the past, then sweep.
    await pool.query('UPDATE rate_limit_buckets SET expires_at = now() - interval \'1 second\' WHERE route = $1', [routeName])
    const removed = await limiter.sweepExpired()
    assert.ok(removed >= 3, `the sweep removes the expired rows, removed ${String(removed)}`)
    assert.equal((await rowsFor(routeName)).length, 0)
  })

  it('falls back to per-process counting on database errors and logs exactly once', async () => {
    const broken: RateLimitQueryable = {
      async query() {
        throw Object.assign(new Error('connect ECONNREFUSED — never logged verbatim'), { name: 'ConnectionRefused' })
      },
    }
    const lines: string[] = []
    const limiter = createSharedRateLimiter({ pool: broken, log: (line) => lines.push(line) })
    const rule = { limit: 2, windowMs: 60_000 }
    assert.equal((await limiter.acquire(route('fb'), `fb-${run}`, rule)).allowed, true)
    assert.equal((await limiter.acquire(route('fb'), `fb-${run}`, rule)).allowed, true)
    const denied = await limiter.acquire(route('fb'), `fb-${run}`, rule)
    assert.equal(denied.allowed, false, 'the fallback still enforces the budget in process')
    assert.ok(denied.retryAfterMs > 0)
    assert.equal(lines.length, 1, `the fallback is logged once, got ${String(lines.length)} lines`)
    assert.match(lines[0]!, /per server process/)
    assert.ok(!lines[0]!.includes('ECONNREFUSED'), 'the raw database error text is not logged')
    // And it never throws at the caller: acquire stays a decision, not an error.
    assert.equal((await limiter.sweepExpired()), 0)
  })

  it('Better Auth storage consume: one shared budget across two storages, seconds Retry-After', async () => {
    const routeName = route('auth')
    // The storage counts under route 'auth'; use one subject, but isolate the
    // bucket from other runs by embedding this run's tag in the key Better
    // Auth would build (ip + path).
    const key = `198.51.100.7|/sign-in/email|${run}`
    const rule = { window: 3600, max: 4 }
    // Both storages must share the table; point them at one limiter.
    const shared = createSharedRateLimiter({ pool })
    const storageA = createAuthRateLimitStorage(() => shared)
    const storageB = createAuthRateLimitStorage(() => shared)
    for (let i = 0; i < 4; i += 1) {
      const storage = i % 2 === 0 ? storageA : storageB
      const decision = await storage.consume(key, rule)
      assert.equal(decision.allowed, true, `request ${String(i + 1)} fits the shared budget`)
    }
    const blocked = await storageB.consume(key, rule)
    assert.equal(blocked.allowed, false)
    assert.ok(blocked.retryAfter !== null && blocked.retryAfter >= 1 && blocked.retryAfter <= 3600, `retryAfter is whole seconds, got ${String(blocked.retryAfter)}`)
    // A different path+ip key is unaffected.
    const other = await storageA.consume(`203.0.113.9|/sign-in/email|${run}`, rule)
    assert.equal(other.allowed, true)
  })
})

describe('rate limit env overrides', () => {
  it('HITLY_RATE_LIMIT_<NAME>_LIMIT / _WINDOW_MS win; invalid values name the variable', () => {
    const rule = rateLimitRuleFromEnv('mfa-verify', { limit: 10, windowMs: 900_000 }, {
      HITLY_RATE_LIMIT_MFA_VERIFY_LIMIT: '3',
      HITLY_RATE_LIMIT_MFA_VERIFY_WINDOW_MS: '1000',
    })
    assert.deepEqual(rule, { limit: 3, windowMs: 1000 })
    const fallback = rateLimitRuleFromEnv('mfa-verify', { limit: 10, windowMs: 900_000 }, {})
    assert.deepEqual(fallback, { limit: 10, windowMs: 900_000 })
    assert.throws(
      () => rateLimitRuleFromEnv('mfa-verify', { limit: 10, windowMs: 900_000 }, { HITLY_RATE_LIMIT_MFA_VERIFY_LIMIT: 'abc' }),
      /HITLY_RATE_LIMIT_MFA_VERIFY_LIMIT/,
    )
    assert.throws(
      () => rateLimitRuleFromEnv('reset-check-shared', { limit: 10, windowMs: 900_000 }, { HITLY_RATE_LIMIT_RESET_CHECK_SHARED_WINDOW_MS: '-5' }),
      /HITLY_RATE_LIMIT_RESET_CHECK_SHARED_WINDOW_MS/,
    )
  })
})
