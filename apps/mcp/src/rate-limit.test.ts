import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RATE_LIMIT, DEFAULT_RATE_WINDOW_MS, loadConfig } from './config.ts'
import { createRateLimiter } from './rate-limit.ts'
import { clientIdFor } from './logger.ts'
import { FakeHost, OTHER_KEY, startHarness, TEST_KEY } from './test-helpers.ts'

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

test('rate limiter unit: fixed window per id, Retry-After counts down, window resets', () => {
  let now = 1_000_000
  const limiter = createRateLimiter(3, 60_000, () => now)
  assert.deepEqual(limiter.tryConsume('a'), { ok: true })
  assert.deepEqual(limiter.tryConsume('a'), { ok: true })
  assert.deepEqual(limiter.tryConsume('a'), { ok: true })
  const blocked = limiter.tryConsume('a')
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.retryAfterMs, 60_000)
  // Independent keys.
  assert.deepEqual(limiter.tryConsume('b'), { ok: true })
  // Mid-window: Retry-After reflects the time left.
  now += 45_000
  const later = limiter.tryConsume('a')
  assert.equal(later.ok, false)
  if (!later.ok) assert.equal(later.retryAfterMs, 15_000)
  // Window rolled over: fresh budget.
  now += 15_001
  assert.deepEqual(limiter.tryConsume('a'), { ok: true })
  // limit <= 0 disables.
  const off = createRateLimiter(0, 60_000, () => now)
  for (let i = 0; i < 100; i++) assert.deepEqual(off.tryConsume('a'), { ok: true })
})

test('config: rate limit and window come from env with sane defaults', () => {
  const defaults = loadConfig({})
  assert.equal(defaults.rateLimit, DEFAULT_RATE_LIMIT)
  assert.equal(defaults.rateWindowMs, DEFAULT_RATE_WINDOW_MS)
  assert.equal(DEFAULT_RATE_LIMIT, 120)
  assert.equal(DEFAULT_RATE_WINDOW_MS, 60_000)
  assert.equal(loadConfig({ HITLY_MCP_RATE_LIMIT: '5', HITLY_MCP_RATE_LIMIT_WINDOW_MS: '1000' }).rateLimit, 5)
  assert.equal(loadConfig({ HITLY_MCP_RATE_LIMIT: '0' }).rateLimit, 0)
  assert.throws(() => loadConfig({ HITLY_MCP_RATE_LIMIT: '-1' }), /HITLY_MCP_RATE_LIMIT/)
  assert.throws(() => loadConfig({ HITLY_MCP_RATE_LIMIT: 'abc' }), /HITLY_MCP_RATE_LIMIT/)
  assert.throws(() => loadConfig({ HITLY_MCP_RATE_LIMIT_WINDOW_MS: '0' }), /HITLY_MCP_RATE_LIMIT_WINDOW_MS/)
})

test('over-limit requests get 429 with Retry-After; the key recovers after the window', async () => {
  const h = await startHarness({ env: { HITLY_MCP_RATE_LIMIT: '3', HITLY_MCP_RATE_LIMIT_WINDOW_MS: '1500' } })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await postMcp(h.url, TEST_KEY)).status, 200, `request ${String(i + 1)} allowed`)
    const blocked = await postMcp(h.url, TEST_KEY)
    assert.equal(blocked.status, 429)
    const retryAfter = blocked.headers.get('retry-after')
    assert.ok(retryAfter !== null && /^[1-9]\d*$/.test(retryAfter), `Retry-After must be a positive integer of seconds, got ${String(retryAfter)}`)
    assert.ok(Number(retryAfter) <= 2)
    assert.match(await blocked.text(), /Rate limit exceeded/)
    assert.ok(h.logs.some((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      return entry.event === 'rate_limit' && entry.status === 'rate_limited' && entry.clientId === clientIdFor(TEST_KEY)
    }), 'rate limit hit must be logged')
    await new Promise((resolve) => setTimeout(resolve, 1_700))
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 200, 'budget replenished after the window')
  } finally {
    await h.close()
  }
})

test('the limit is per API key: one exhausted key never starves another', async () => {
  const host = new FakeHost()
  const h = await startHarness({ host, env: { HITLY_MCP_RATE_LIMIT: '2', HITLY_MCP_RATE_LIMIT_WINDOW_MS: '60000' } })
  try {
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 200)
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 200)
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 429)
    assert.equal((await postMcp(h.url, OTHER_KEY)).status, 200, 'the other key is unaffected')
  } finally {
    await h.close()
  }
})

test('token budgets key on the client address: rotating delegated tokens cannot mint fresh budgets', async () => {
  const seg = (c: string, n: number) => c.repeat(n)
  const token = (c: string) => `${seg(c, 20)}.${seg('p', 20)}.${seg('q', 20)}`
  const h = await startHarness({
    env: { HITLY_MCP_RATE_LIMIT: '2', HITLY_MCP_RATE_LIMIT_WINDOW_MS: '60000' },
    deps: { verifyToken: async () => ({ ok: true } as const) },
  })
  try {
    assert.equal((await postMcp(h.url, token('a'))).status, 200)
    assert.equal((await postMcp(h.url, token('b'))).status, 200)
    // A third credential, never seen before, still hits the wall: the budget
    // belongs to the address, not to the (rotatable) presented token.
    assert.equal((await postMcp(h.url, token('c'))).status, 429)
    // API keys keep their own per-key subject and are unaffected.
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 200)
  } finally {
    await h.close()
  }
})

test('a host 429 during token verification propagates as 429 with Retry-After, not 401', async () => {
  const seg = (c: string, n: number) => c.repeat(n)
  const token = `${seg('t', 20)}.${seg('p', 20)}.${seg('q', 20)}`
  const h = await startHarness({
    deps: { verifyToken: async () => ({ ok: false, status: 429, retryAfterMs: 30_000 } as const) },
  })
  try {
    const res = await postMcp(h.url, token)
    assert.equal(res.status, 429, 'rate-limited by the host must not look like an invalid token')
    assert.equal(res.headers.get('retry-after'), '30')
    assert.ok(h.logs.some((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      return entry.status === 'host_rate_limited'
    }), 'host rate limiting must be logged')
  } finally {
    await h.close()
  }
})

test('unauthenticated traffic does not consume a key budget, and HITLY_MCP_RATE_LIMIT=0 disables', async () => {
  const h = await startHarness({ env: { HITLY_MCP_RATE_LIMIT: '1' } })
  try {
    for (let i = 0; i < 4; i++) assert.equal((await postMcp(h.url, null)).status, 401, 'missing keys are refused as 401, never 429')
    // Malformed credentials are refused before verification and before the limiter.
    assert.equal((await postMcp(h.url, 'nope!!')).status, 401)
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 200, 'first authenticated request still allowed')
    assert.equal((await postMcp(h.url, TEST_KEY)).status, 429, 'limit of 1 really applied')
  } finally {
    await h.close()
  }
  const off = await startHarness({ env: { HITLY_MCP_RATE_LIMIT: '0' } })
  try {
    for (let i = 0; i < 10; i++) assert.equal((await postMcp(off.url, TEST_KEY)).status, 200)
  } finally {
    await off.close()
  }
})
