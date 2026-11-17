/**
 * LIVE MCP database-limiter tests: the DB-backed limiter must key per API
 * key (a constant subject would let one key starve every other), on the real
 * shared table (not the in-process map). Requires DATABASE_URL (CI provides
 * it alongside Postgres; without it the file skips).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { createDefaultRateLimitPool } from '@hitly/db/rate-limit'
import { createDbBackedRateLimiter } from './rate-limit'

const url = process.env.DATABASE_URL
const suite = url ? describe : describe.skip

suite('MCP DB-backed limiter is per key (MC2)', () => {
  it('exhausting one key never starves another; both get their own bucket row', async () => {
    const run = Math.random().toString(36).slice(2, 12)
    const keyA = `mcp-key-A-${run}`
    const keyB = `mcp-key-B-${run}`
    const expectedA = createHash('sha256').update(`mcp\u0000${keyA}`, 'utf8').digest('hex')
    const expectedB = createHash('sha256').update(`mcp\u0000${keyB}`, 'utf8').digest('hex')
    const pool = await createDefaultRateLimitPool(url as string)
    const limiter = await createDbBackedRateLimiter({
      databaseUrl: url as string,
      limit: 3,
      windowMs: 60_000,
      log: () => {},
    })
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await limiter.acquire(keyA)
        assert.equal(ok.ok, true, `key A request ${i + 1} is allowed`)
      }
      const exhausted = await limiter.acquire(keyA)
      assert.equal(exhausted.ok, false, 'key A is over its limit')
      assert.ok(exhausted.retryAfterMs > 0)
      const other = await limiter.acquire(keyB)
      assert.equal(other.ok, true, 'key B must be unaffected by key A exhaustion (MC2)')

      const rows = await pool.query(
        'SELECT bucket_key FROM rate_limit_buckets WHERE route = $1 AND bucket_key = ANY($2::text[])',
        ['mcp', [expectedA, expectedB]],
      )
      const keys = (rows.rows as Array<{ bucket_key: string }>).map((r) => r.bucket_key).sort()
      assert.deepEqual(keys, [expectedA, expectedB].sort(), 'one row per key, keyed by SHA-256(route+NUL+clientId)')
      assert.notEqual(expectedA, expectedB, 'the subject must be the key, not a constant')
    } finally {
      await pool.query('DELETE FROM rate_limit_buckets WHERE route = $1 AND bucket_key = ANY($2::text[])', [
        'mcp',
        [expectedA, expectedB],
      ])
      await limiter.close()
      await pool.end()
    }
  })
})
