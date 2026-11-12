/**
 * Shared-database MCP rate limiting. The server-level test proves the server
 * honours an injected async acquirer (429 + Retry-After); the limiter tests
 * exercise the real `rate_limit_buckets` table when DATABASE_URL points at a
 * Postgres (same gate the app live tests use).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDbBackedRateLimiter, createRateLimiter } from './rate-limit.ts'
import { clientIdFor } from './logger.ts'
import { startHarness, TEST_KEY } from './test-helpers.ts'

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
})

async function postMcp(url: string, key: string | null): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: INITIALIZE,
  })
}

test('the server honours an injected async rate acquirer: 429 with Retry-After', async () => {
  let calls = 0
  const h = await startHarness({
    deps: {
      rateAcquire: async (clientId) => {
        calls += 1
        assert.equal(clientId, clientIdFor(TEST_KEY), 'the acquirer sees the hashed client id')
        if (calls <= 2) return { ok: true, retryAfterMs: 0 }
        return { ok: false, retryAfterMs: 12_000 }
      },
    },
  })
  try {
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 200)
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 200)
    const blocked = await postMcp(h.url, TEST_KEY)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '12')
    assert.match(await blocked.text(), /Rate limit exceeded/)
  } finally {
    await h.close()
  }
})

test('the memory default stays a fixed-window per-process limiter', () => {
  let now = 0
  const limiter = createRateLimiter(1, 1000, () => now)
  assert.deepEqual(limiter.tryConsume('a'), { ok: true })
  assert.equal(limiter.tryConsume('a').ok, false)
  now = 1001
  assert.deepEqual(limiter.tryConsume('a'), { ok: true })
})

const DATABASE_URL = process.env.DATABASE_URL

test(
  'shared-database: two limiter instances sharing the database enforce one per-key budget',
  { skip: DATABASE_URL ? false : 'DATABASE_URL not set' },
  async () => {
    const tag = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const a = await createDbBackedRateLimiter({ databaseUrl: DATABASE_URL!, limit: 3, windowMs: 60_000 })
    const b = await createDbBackedRateLimiter({ databaseUrl: DATABASE_URL!, limit: 3, windowMs: 60_000 })
    try {
      // clientIdFor keeps the subject short; the bucket key hashes route+subject,
      // so the tag inside the id makes this run's bucket unique.
      const clientId = clientIdFor(`hitly_${tag}${'a'.repeat(24)}`)
      const results = []
      for (let i = 0; i < 3; i += 1) {
        results.push((await (i % 2 === 0 ? a : b).acquire(clientId)).ok)
      }
      assert.ok(results.every(Boolean), 'the first three requests across instances fit')
      const blocked = await b.acquire(clientId)
      assert.equal(blocked.ok, false, 'the fourth request from either instance is refused')
      assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000)
    } finally {
      await a.close()
      await b.close()
    }
  },
)

test(
  'shared-database: a failing connection degrades to per-process counting with one log line',
  { skip: DATABASE_URL ? false : 'DATABASE_URL not set (an unreachable URL is used here)' },
  async () => {
    // A never-connecting URL: the pool defers connection until the first
    // query, which fails, so every acquire uses the in-process fallback.
    const lines: string[] = []
    const limiter = await createDbBackedRateLimiter({
      databaseUrl: 'postgres://hitly:hitly@127.0.0.1:1/hitly?connect_timeout=1',
      limit: 1,
      windowMs: 60_000,
      log: (line) => lines.push(line),
    })
    try {
      assert.equal((await limiter.acquire('key_down')).ok, true)
      assert.equal((await limiter.acquire('key_down')).ok, false, 'the per-process budget still applies')
      assert.equal(lines.length, 1, `the fallback logs once, got ${String(lines.length)}`)
      assert.match(lines[0]!, /per server process/)
    } finally {
      await limiter.close()
    }
  },
)
