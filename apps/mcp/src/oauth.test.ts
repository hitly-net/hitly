import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractBearer, protectedResourceMetadata, verifyDelegatedToken, MCP_SCOPE } from './oauth.ts'
import { loadConfig } from './config.ts'
import { startHarness, TEST_KEY, baseApproval, structured } from './test-helpers.ts'

const PUBLIC_URL = 'https://mcp.hitly.net'
const OPAQUE_TOKEN = 'eyJhbGciOiJub25lIn0.dGVzdC1kZWxlZ2F0ZWQtdG9rZW4.sig_1234567890abcdef'
const OPAQUE_TOKEN_HEADER = `Bearer ${OPAQUE_TOKEN}`

test('extractBearer classifies keys, delegated tokens and junk', () => {
  assert.deepEqual(extractBearer(undefined), { error: 'missing' })
  assert.deepEqual(extractBearer(`Bearer ${TEST_KEY}`), { kind: 'apikey', key: TEST_KEY })
  assert.deepEqual(extractBearer(OPAQUE_TOKEN_HEADER), { kind: 'token', token: OPAQUE_TOKEN })
  assert.deepEqual(extractBearer('Bearer hitly_resume_AAAAAAAAAAAAAAAAAAAAAAAA'), { error: 'invalid' })
  assert.deepEqual(extractBearer('Bearer hitly_short'), { error: 'invalid' })
  assert.deepEqual(extractBearer('Bearer ab'), { error: 'invalid' })
  assert.deepEqual(extractBearer(`Basic ${TEST_KEY}`), { error: 'invalid' })
  assert.deepEqual(extractBearer(`Bearer ${TEST_KEY} extra`), { error: 'invalid' })
})

test('verifyDelegatedToken trusts only an explicit host acceptance', async () => {
  const config = loadConfig({ HITLY_API_URL: 'https://hitly.example' })
  const calls: { url: string; auth?: string }[] = []
  const ok = await verifyDelegatedToken(config, OPAQUE_TOKEN, async (url, init) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization })
    return new Response('{}', { status: 200 })
  })
  assert.deepEqual(ok, { ok: true })
  assert.deepEqual(calls, [{ url: 'https://hitly.example/api/v1/mcp/verify-token', auth: `Bearer ${OPAQUE_TOKEN}` }])

  const rejected = await verifyDelegatedToken(config, OPAQUE_TOKEN, async () => new Response('{}', { status: 401 }))
  assert.deepEqual(rejected, { ok: false, status: 401 })

  const unreachable = await verifyDelegatedToken(config, OPAQUE_TOKEN, (async () => {
    throw new Error('boom')
  }) as never)
  assert.deepEqual(unreachable, { ok: false, status: 502 })
})

test('protected resource metadata advertises issuer and scope only when public', () => {
  const publicConfig = loadConfig({ HITLY_MCP_PUBLIC_URL: PUBLIC_URL, HITLY_API_URL: 'https://hitly.example' })
  assert.deepEqual(protectedResourceMetadata(publicConfig), {
    resource: PUBLIC_URL,
    authorization_servers: ['https://hitly.example'],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_SCOPE],
  })
  const issuerConfig = loadConfig({ HITLY_MCP_PUBLIC_URL: PUBLIC_URL, HITLY_MCP_OAUTH_ISSUER: 'https://cloud.hitly.net/' })
  assert.deepEqual(protectedResourceMetadata(issuerConfig)?.authorization_servers, ['https://cloud.hitly.net'])
  assert.equal(protectedResourceMetadata(loadConfig({ HITLY_API_URL: 'https://hitly.example' })), undefined)
})

test('PRM endpoint serves metadata; 401 challenges point clients at it', async () => {
  const h = await startHarness({ env: { HITLY_MCP_PUBLIC_URL: PUBLIC_URL } })
  try {
    const prm = await fetch(`${h.url}/.well-known/oauth-protected-resource`)
    assert.equal(prm.status, 200)
    assert.deepEqual(await prm.json(), {
      resource: PUBLIC_URL,
      authorization_servers: ['https://hitly.example'],
      bearer_methods_supported: ['header'],
      scopes_supported: [MCP_SCOPE],
    })
    const unauth = await fetch(`${h.url}/mcp`, { method: 'POST', body: '{}' })
    assert.equal(unauth.status, 401)
    assert.match(
      String(unauth.headers.get('www-authenticate')),
      /^Bearer realm="hitly-mcp", resource_metadata="https:\/\/mcp\.hitly\.net\/\.well-known\/oauth-protected-resource"$/,
    )
  } finally {
    await h.close()
  }
})

test('delegated token: verified once, then forwarded to the host as presented', async () => {
  const verified: string[] = []
  const h = await startHarness({
    deps: {
      verifyToken: (token) => {
        verified.push(token)
        return Promise.resolve(token === OPAQUE_TOKEN ? { ok: true } : { ok: false, status: 401 })
      },
    },
  })
  try {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${OPAQUE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 200)
    const tools = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    assert.deepEqual(tools, ['request_approval', 'ask_user', 'get_decision', 'list_pending', 'cancel'])

    // The host call carries the presented token — never a swapped-in key —
    // so tenancy and revocation stay entirely the host's business.
    h.host.validKeys.add(OPAQUE_TOKEN)
    const client = await h.client(OPAQUE_TOKEN)
    const ingested = structured(await client.callTool({ name: 'request_approval', arguments: { ...baseApproval } }))
    assert.equal(ingested.state, 'pending')
    assert.equal(h.host.ingests.length, 1)
    assert.equal(h.host.ingests[0].key, OPAQUE_TOKEN)
    assert.ok(verified.includes(OPAQUE_TOKEN))

    const bad = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer notmytoken000000000000' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    assert.equal(bad.status, 401)
    assert.match(String(bad.headers.get('www-authenticate')), /^Bearer realm="hitly-mcp"$/)
  } finally {
    await h.close()
  }
})

test('delegated token: host trouble surfaces as 502, never as acceptance', async () => {
  const h = await startHarness({ deps: { verifyToken: () => Promise.resolve({ ok: false, status: 502 }) } })
  try {
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${OPAQUE_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 502)
  } finally {
    await h.close()
  }
})
