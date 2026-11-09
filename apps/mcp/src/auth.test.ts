import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractApiKey } from './server.ts'
import { baseApproval, startHarness, structured, TEST_KEY } from './test-helpers.ts'

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
}

async function rawPost(url: string, headers: Record<string, string>) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initialize),
  })
}

test('missing API key is refused with 401 and a Bearer challenge', async () => {
  const h = await startHarness()
  try {
    const res = await rawPost(h.url, {})
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/)
    const body = (await res.json()) as { error: { message: string } }
    assert.equal(body.error.message, 'Missing API key')
    await assert.rejects(() => h.client(null))
  } finally {
    await h.close()
  }
})

test('malformed keys and resume tokens are refused before any tool runs', async () => {
  const h = await startHarness()
  try {
    for (const header of ['Bearer', 'Basic abc', 'Bearer not-a-hitly-key', 'Bearer hitly_short', `Bearer hitly_resume_${'A'.repeat(32)}`, `${TEST_KEY}`]) {
      const res = await rawPost(h.url, { authorization: header })
      assert.equal(res.status, 401, header)
      assert.equal(((await res.json()) as { error: { message: string } }).error.message, 'Invalid API key')
    }
    assert.equal(h.host.ingests.length, 0)
  } finally {
    await h.close()
  }
})

test('a well-formed key the host rejects surfaces as an unauthorized tool error', async () => {
  const h = await startHarness()
  try {
    const client = await h.client('hitly_unknown_CCCCCCCCCCCCCCCCCCCCCCCC')
    const result = await client.callTool({ name: 'request_approval', arguments: baseApproval })
    assert.equal(result.isError, true)
    assert.equal((structured(result).error as { code: string }).code, 'unauthorized')
    const read = await client.callTool({ name: 'get_decision', arguments: { requestId: 'apr_0001' } })
    assert.equal((structured(read).error as { code: string }).code, 'unauthorized')
  } finally {
    await h.close()
  }
})

test('a key cannot read another key\u2019s request', async () => {
  const h = await startHarness()
  try {
    const mine = await h.client()
    const created = structured(await mine.callTool({ name: 'request_approval', arguments: baseApproval }))
    const other = await h.client('hitly_otherkey_BBBBBBBBBBBBBBBBBBBBBBBB')
    const read = await other.callTool({ name: 'get_decision', arguments: { requestId: created.requestId as string } })
    assert.equal(read.isError, true)
    assert.equal((structured(read).error as { code: string }).code, 'not_found')
  } finally {
    await h.close()
  }
})

test('extractApiKey', () => {
  assert.deepEqual(extractApiKey(undefined), { error: 'missing' })
  assert.deepEqual(extractApiKey(`bearer ${TEST_KEY}`), { key: TEST_KEY })
  assert.deepEqual(extractApiKey(`Bearer ${TEST_KEY} extra`), { error: 'invalid' })
})

test('GET /mcp is 405 (stateless, POST only); unknown paths 404; noop callback sink is 204', async () => {
  const h = await startHarness()
  try {
    assert.equal((await fetch(`${h.url}/mcp`)).status, 405)
    assert.equal((await fetch(`${h.url}/other`)).status, 404)
    assert.equal((await fetch(`${h.url}/callbacks/noop`, { method: 'POST', body: '{"x":1}' })).status, 204)
  } finally {
    await h.close()
  }
})
