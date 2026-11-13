/**
 * LIVE cross-instance test for the REST shared limiter: two acquirers over
 * one Postgres enforce one rest-read budget (same harness as the other
 * *.live tests).
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createSharedRateLimiter } from '@hitly/db/rate-limit'
import { applyRestLimit } from './rest-limit'
import { newId } from './ids'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required for these tests')
const pool = new pg.Pool({ connectionString: url, max: 2 })
after(async () => {
  await pool.end()
})

const run = newId('rr').slice(-10)

describe('REST shared limiter (live Postgres)', () => {
  it('two instances over one database enforce one rest-read budget', async () => {
    const limiter = createSharedRateLimiter({ pool })
    const route = `t-${run}-rest-read`.slice(0, 64)
    const rule = { limit: 3, windowMs: 60_000 }
    const subject = 'user-' + run
    const acquireA = (s: string) => limiter.acquire(route, s, rule)
    const acquireB = (s: string) => limiter.acquire(route, s, rule)

    // Interleave the two "processes"; the budget of 3 is shared.
    assert.equal(await applyRestLimit('read', subject, acquireA), null)
    assert.equal(await applyRestLimit('read', subject, acquireB), null)
    assert.equal(await applyRestLimit('read', subject, acquireA), null)
    const fourth = await applyRestLimit('read', subject, acquireB)
    assert.ok(fourth)
    assert.equal(fourth.status, 429)
    assert.match(String(fourth.headers.get('retry-after')), /^\d+$/)

    const rows = (
      await pool.query('SELECT bucket_key, count FROM rate_limit_buckets WHERE route = $1', [route])
    ).rows as Array<{ bucket_key: string; count: number }>
    assert.equal(rows.length, 1)
    // The refused fourth attempt counted too (atomic increment, then deny):
    // count 4 with the 4th answered 429 is the proof of a shared counter.
    assert.equal(rows[0].count, 4)
    assert.match(rows[0].bucket_key, /^[0-9a-f]{64}$/)
  })
})
