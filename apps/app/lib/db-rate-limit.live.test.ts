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
import { createHash } from 'node:crypto'
import pg from 'pg'
import {
  createSharedRateLimiter,
  rateLimitBucketKey,
  rateLimitRuleFromEnv,
  resetRateLimitEnvWarningsForTests,
  type RateLimitQueryable,
} from '@hitly/db/rate-limit'
import { createAuthRateLimitStorage, createRateAcquire, setSharedRateLimiterForTests } from './rate-limit'
import { handleIngestPost } from './ingest-route'
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
  it('HITLY_RATE_LIMIT_<NAME>_LIMIT / _WINDOW_MS win; unusable values warn once (value-free) and keep the default', () => {
    resetRateLimitEnvWarningsForTests()
    const lines: string[] = []
    const warn = (line: string) => lines.push(line)
    const rule = rateLimitRuleFromEnv('mfa-verify', { limit: 10, windowMs: 900_000 }, {
      HITLY_RATE_LIMIT_MFA_VERIFY_LIMIT: '3',
      HITLY_RATE_LIMIT_MFA_VERIFY_WINDOW_MS: '1000',
    }, warn)
    assert.deepEqual(rule, { limit: 3, windowMs: 1000 })
    const fallback = rateLimitRuleFromEnv('mfa-verify', { limit: 10, windowMs: 900_000 }, {}, warn)
    assert.deepEqual(fallback, { limit: 10, windowMs: 900_000 })

    // An unusable LIMIT is never fatal: it keeps the default and warns naming
    // only the variable — the bogus value is never echoed (and never thrown,
    // so a typo in one variable can never 500 the app at startup).
    const bad = rateLimitRuleFromEnv('mfa-verify', { limit: 10, windowMs: 900_000 }, {
      HITLY_RATE_LIMIT_MFA_VERIFY_LIMIT: 'abc',
    }, warn)
    assert.deepEqual(bad, { limit: 10, windowMs: 900_000 })
    // A LIMIT of 0 silently disabling a limiter is never allowed either.
    const zero = rateLimitRuleFromEnv('password-change', { limit: 10, windowMs: 900_000 }, {
      HITLY_RATE_LIMIT_PASSWORD_CHANGE_LIMIT: '0',
    }, warn)
    assert.deepEqual(zero, { limit: 10, windowMs: 900_000 })
    const badWindow = rateLimitRuleFromEnv('reset-check-shared', { limit: 10, windowMs: 900_000 }, {
      HITLY_RATE_LIMIT_RESET_CHECK_SHARED_WINDOW_MS: '-5',
    }, warn)
    assert.deepEqual(badWindow, { limit: 10, windowMs: 900_000 })

    assert.equal(lines.length, 3)
    assert.ok(lines[0]?.includes('HITLY_RATE_LIMIT_MFA_VERIFY_LIMIT'))
    assert.ok(!lines[0]?.includes('abc'), 'the warning never echoes the value')
    assert.ok(lines[1]?.includes('HITLY_RATE_LIMIT_PASSWORD_CHANGE_LIMIT'))
    assert.ok(lines[2]?.includes('HITLY_RATE_LIMIT_RESET_CHECK_SHARED_WINDOW_MS'))

    // Warnings fire once per variable, not per call.
    rateLimitRuleFromEnv('mfa-verify', { limit: 10, windowMs: 900_000 }, {
      HITLY_RATE_LIMIT_MFA_VERIFY_LIMIT: 'abc',
    }, warn)
    assert.equal(lines.length, 3)
  })
})

describe('shared budget across two separate pools (M2)', () => {
  it('exactly `limit` allowed across independent pools and limiter instances', async () => {
    const poolA = new pg.Pool({ connectionString: url, max: 12 })
    const poolB = new pg.Pool({ connectionString: url, max: 12 })
    try {
      const limiterA = createSharedRateLimiter({ pool: poolA })
      const limiterB = createSharedRateLimiter({ pool: poolB })
      const route = 'm2-two-pool'
      const subject = 'two-pool-' + newId('rl')
      const rule = { limit: 20, windowMs: 60_000 }
      const calls: Array<Promise<{ allowed: boolean; retryAfterMs: number }>> = []
      for (let i = 0; i < 50; i++) calls.push(limiterA.acquire(route, subject, rule))
      for (let i = 0; i < 50; i++) calls.push(limiterB.acquire(route, subject, rule))
      const decisions = await Promise.all(calls)
      const allowed = decisions.filter((d) => d.allowed).length
      assert.equal(allowed, 20, 'exactly the budget is allowed across BOTH instances')
      const refused = decisions.find((d) => !d.allowed)
      // Both instances share one window; their per-call clocks may differ by
      // a millisecond, so allow a small skew around the 60 s window.
      assert.ok(refused && refused.retryAfterMs >= 59_000 && refused.retryAfterMs <= 61_000, `refused carries a window-sized Retry-After, got ${String(refused?.retryAfterMs)}`)
    } finally {
      await poolA.end()
      await poolB.end()
    }
  })
})

describe('fixed-window anchoring (M2)', () => {
  it('the window is anchored at the first request and refusals never slide it', async () => {
    let t = Date.parse('2026-01-01T00:00:00Z')
    const limiter = createSharedRateLimiter({ pool, now: () => t, sweepIntervalMs: 0 })
    const route = 'm2-fixed-window'
    const subject = 'fw-' + newId('rl')
    const rule = { limit: 2, windowMs: 1000 }
    assert.equal((await limiter.acquire(route, subject, rule)).allowed, true)
    assert.equal((await limiter.acquire(route, subject, rule)).allowed, true)
    assert.equal((await limiter.acquire(route, subject, rule)).allowed, false)
    t += 500
    assert.equal((await limiter.acquire(route, subject, rule)).allowed, false, 'mid-window stays denied')
    t += 501
    // The window opened at t0, so at t0+1001 it is over even though attempts
    // kept arriving — a sliding-window implementation would still deny here.
    assert.equal((await limiter.acquire(route, subject, rule)).allowed, true, 'the anchored window reopened')
  })
})

describe('bucket key pin and per-family subjects (M2)', () => {
  it('bucket_key is the literal SHA-256 of route + NUL + subject; families never share a bucket', async () => {
    const route = 'm2-keypin'
    const subject = 'pin-' + newId('rl')
    const expected = createHash('sha256').update(`${route}\u0000${subject}`, 'utf8').digest('hex')
    assert.equal(rateLimitBucketKey(route, subject), expected, 'the bucket key is the literal SHA-256')
    const limiter = createSharedRateLimiter({ pool })
    await limiter.acquire(route, subject, { limit: 5, windowMs: 60_000 })
    const rows = await pool.query('SELECT bucket_key, route FROM rate_limit_buckets WHERE bucket_key = $1', [expected])
    assert.equal(rows.rowCount, 1, 'the stored row is findable by the literal hash')
    assert.equal(rows.rows[0].route, route)
    assert.notEqual(rateLimitBucketKey('invite', subject), expected, 'the route is part of the key')

    const sharedSubject = 'shared-subj-' + newId('rl')
    const rule = { limit: 3, windowMs: 60_000 }
    for (let i = 0; i < 3; i++) assert.equal((await limiter.acquire('rest-read', sharedSubject, rule)).allowed, true)
    assert.equal((await limiter.acquire('rest-read', sharedSubject, rule)).allowed, false)
    assert.equal((await limiter.acquire('invite', sharedSubject, rule)).allowed, true, 'distinct families, distinct budgets')
    assert.equal((await limiter.acquire('failed-auth', sharedSubject, rule)).allowed, true)
  })
})

describe('HITLY_RATE_LIMIT_DB and app-pool wiring (M2)', () => {
  it('the app counts through the app pool; HITLY_RATE_LIMIT_DB=0 keeps it per-process', async () => {
    const route = 'm2wiring' + newId('rl').replace(/-/g, '')
    const saved = process.env.HITLY_RATE_LIMIT_DB
    delete process.env.HITLY_RATE_LIMIT_DB
    setSharedRateLimiterForTests(null)
    try {
      const subject = 'w-' + newId('rl')
      const acq = createRateAcquire(route, { limit: 5, windowMs: 60_000 })
      assert.equal((await acq(subject)).allowed, true)
      const key = rateLimitBucketKey(route, subject)
      const row = await pool.query('SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1', [key])
      assert.equal(row.rowCount, 1, 'the app pool path wrote the shared bucket')

      process.env.HITLY_RATE_LIMIT_DB = '0'
      setSharedRateLimiterForTests(null)
      const acq2 = createRateAcquire(route, { limit: 1, windowMs: 60_000 })
      const subject2 = 'w-' + newId('rl')
      assert.equal((await acq2(subject2)).allowed, true)
      assert.equal((await acq2(subject2)).allowed, false, 'per-process budget enforced with the DB off')
      const row2 = await pool.query('SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1', [rateLimitBucketKey(route, subject2)])
      assert.equal(row2.rowCount, 0, 'nothing reaches the table with HITLY_RATE_LIMIT_DB=0')
    } finally {
      if (saved === undefined) delete process.env.HITLY_RATE_LIMIT_DB
      else process.env.HITLY_RATE_LIMIT_DB = saved
      setSharedRateLimiterForTests(null)
    }
  })
})

describe('failed-auth before counting (M5, live)', () => {
  it('1000 junk keys mint no per-key rows and the address budget answers 429', async () => {
    const savedProxies = process.env.HITLY_TRUSTED_PROXIES
    const savedLimit = process.env.HITLY_RATE_LIMIT_FAILED_AUTH_LIMIT
    process.env.HITLY_TRUSTED_PROXIES = '127.0.0.1'
    process.env.HITLY_RATE_LIMIT_FAILED_AUTH_LIMIT = '25'
    const clientIp = '198.18.' + (10 + (Date.now() % 200)) + '.' + (10 + (Math.floor(Date.now() / 200) % 200))
    try {
      const junkKeys: string[] = []
      let saw429 = false
      let first429At = -1
      for (let i = 0; i < 1000; i++) {
        const junk = 'junk_' + newId('rl') + '_' + i
        junkKeys.push(junk)
        const request = new Request('http://localhost:3001/api/v1/approvals', {
          method: 'POST',
          headers: { authorization: `Bearer ${junk}`, 'content-type': 'application/json', 'x-forwarded-for': clientIp },
          body: JSON.stringify({ plugin: 'x' }),
        })
        const response = await handleIngestPost(request, { log: () => {} })
        if (response.status === 429) {
          saw429 = true
          first429At = i
          assert.ok(Number(response.headers.get('retry-after')) >= 1, 'the 429 carries Retry-After')
          break
        }
        assert.equal(response.status, 401, 'junk keys get the standard 401 until the address budget is spent')
      }
      assert.ok(saw429, 'the per-address failed-auth budget refused the flood')
      assert.ok(first429At >= 20 && first429At <= 30, `429 arrives at the configured budget (saw ${first429At})`)

      const hashes = junkKeys.map((k) => createHash('sha256').update(`${'ingest'}\u0000${createHash('sha256').update(k).digest('hex')}`, 'utf8').digest('hex'))
      const rows = await pool.query('SELECT count(*)::int AS n FROM rate_limit_buckets WHERE bucket_key = ANY($1::text[])', [hashes])
      assert.equal(rows.rows[0].n, 0, 'no per-key row was ever created for an unverified key')
      const failed = await pool.query("SELECT count(*)::int AS n FROM rate_limit_buckets WHERE route = 'failed-auth'")
      assert.ok(failed.rows[0].n >= 1, 'the attempts were counted per address instead')
    } finally {
      if (savedProxies === undefined) delete process.env.HITLY_TRUSTED_PROXIES
      else process.env.HITLY_TRUSTED_PROXIES = savedProxies
      if (savedLimit === undefined) delete process.env.HITLY_RATE_LIMIT_FAILED_AUTH_LIMIT
      else process.env.HITLY_RATE_LIMIT_FAILED_AUTH_LIMIT = savedLimit
    }
  })
})
