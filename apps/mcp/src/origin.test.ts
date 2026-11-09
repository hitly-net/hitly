import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test } from 'node:test'
import { hostHeaderAllowed, isLoopbackBind, normaliseOrigin, originAllowed } from './security.ts'
import { loadConfig } from './config.ts'
import { startHarness, TEST_KEY } from './test-helpers.ts'

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
})

/** Raw HTTP POST to /mcp with exact headers (no implicit Origin, like server-to-server clients). */
function rawPost(
  port: number,
  headers: Record<string, string>,
  body: string = INITIALIZE,
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const auth = { authorization: `Bearer ${TEST_KEY}` }

test('a foreign Origin is refused with 403 before auth and never reaches the host', async () => {
  const h = await startHarness()
  try {
    const res = await rawPost(address(h.url).port, { ...auth, origin: 'https://evil.example' })
    assert.equal(res.status, 403)
    assert.match(res.text, /Origin not allowed/)
    // Refused even with a valid key, and before the credential is considered.
    const noKey = await rawPost(address(h.url).port, { origin: 'https://evil.example' })
    assert.equal(noKey.status, 403)
    assert.equal(h.host.ingests.length, 0)
    assert.ok(h.logs.some((line) => JSON.parse(line).status === 'origin_denied'))
  } finally {
    await h.close()
  }
})

test('no Origin (server-to-server) passes; loopback Origin passes while loopback-bound', async () => {
  const h = await startHarness()
  try {
    const noOrigin = await rawPost(address(h.url).port, { ...auth })
    assert.equal(noOrigin.status, 200)
    assert.match(noOrigin.text, /"name":"hitly"/)
    const loopback = await rawPost(address(h.url).port, { ...auth, origin: 'http://127.0.0.1:9999' })
    assert.equal(loopback.status, 200)
    const localhost = await rawPost(address(h.url).port, { ...auth, origin: 'http://localhost:4321' })
    assert.equal(localhost.status, 200)
  } finally {
    await h.close()
  }
})

test('HITLY_MCP_ALLOWED_ORIGINS extends the allowlist and still refuses foreign origins', async () => {
  const h = await startHarness({ env: { HITLY_MCP_ALLOWED_ORIGINS: 'https://bot.example, http://localhost:8080' } })
  try {
    assert.deepEqual(h.config.allowedOrigins, ['https://bot.example', 'http://localhost:8080'])
    assert.equal((await rawPost(address(h.url).port, { ...auth, origin: 'https://bot.example' })).status, 200)
    assert.equal((await rawPost(address(h.url).port, { ...auth, origin: 'https://evil.example' })).status, 403)
  } finally {
    await h.close()
  }
})

test('the server public origin (HITLY_MCP_PUBLIC_URL) is always allowed on /mcp', async () => {
  const h = await startHarness({ env: { HITLY_MCP_PUBLIC_URL: 'https://mcp.hitly.example' } })
  try {
    assert.equal(h.config.publicUrlOrigin, 'https://mcp.hitly.example')
    assert.equal((await rawPost(address(h.url).port, { ...auth, origin: 'https://mcp.hitly.example' })).status, 200)
  } finally {
    await h.close()
  }
})

test('Host header must be loopback while bound to loopback (DNS-rebinding defence)', async () => {
  const h = await startHarness()
  try {
    const port = address(h.url).port
    assert.equal((await rawPost(port, { ...auth, host: 'evil.example:3006' })).status, 403)
    assert.equal((await rawPost(port, { ...auth, host: '127.0.0.1' })).status, 200)
    assert.equal((await rawPost(port, { ...auth, host: `localhost:${String(port)}` })).status, 200)
    assert.equal((await rawPost(port, { ...auth, host: '[::1]:3006' })).status, 200)
    assert.ok(h.logs.some((line) => JSON.parse(line).status === 'host_denied'))
  } finally {
    await h.close()
  }
})

test('Host check is off when bound to a public interface; Origin check is not', async () => {
  const h = await startHarness({ env: { HITLY_MCP_HOST: '0.0.0.0' } })
  try {
    const port = address(h.url).port
    assert.equal((await rawPost(port, { ...auth, host: 'mcp.hitly.example' })).status, 200)
    assert.equal((await rawPost(port, { ...auth, origin: 'https://evil.example', host: 'mcp.hitly.example' })).status, 403)
  } finally {
    await h.close()
  }
})

test('malformed and null Origins are refused; env entries must be origins', async () => {
  const h = await startHarness()
  try {
    assert.equal((await rawPost(address(h.url).port, { ...auth, origin: 'null' })).status, 403)
    assert.equal((await rawPost(address(h.url).port, { ...auth, origin: 'not a url' })).status, 403)
  } finally {
    await h.close()
  }
  assert.throws(() => loadConfig({ HITLY_MCP_ALLOWED_ORIGINS: 'https://ok.example/path' }), /HITLY_MCP_ALLOWED_ORIGINS/)
  assert.throws(() => loadConfig({ HITLY_MCP_ALLOWED_ORIGINS: 'ok.example' }), /HITLY_MCP_ALLOWED_ORIGINS/)
  assert.deepEqual(loadConfig({ HITLY_MCP_ALLOWED_ORIGINS: ' , ' }).allowedOrigins, [])
})

test('security helpers unit behaviour', () => {
  assert.equal(isLoopbackBind('127.0.0.1'), true)
  assert.equal(isLoopbackBind('localhost'), true)
  assert.equal(isLoopbackBind('::1'), true)
  assert.equal(isLoopbackBind('0.0.0.0'), false)
  assert.equal(isLoopbackBind('::'), false)
  assert.equal(hostHeaderAllowed('127.0.0.1:3006'), true)
  assert.equal(hostHeaderAllowed('evil.example'), false)
  assert.equal(hostHeaderAllowed(undefined), false)
  assert.equal(normaliseOrigin('https://Bot.Example'), 'https://bot.example')
  assert.equal(normaliseOrigin('https://bot.example/path'), null)
  const policy = { allowedOrigins: new Set(['https://bot.example']), publicUrlOrigin: undefined, loopbackBound: true }
  assert.equal(originAllowed(undefined, policy), true)
  assert.equal(originAllowed('', policy), true)
  assert.equal(originAllowed('https://bot.example', policy), true)
  assert.equal(originAllowed('http://127.0.0.1:1', policy), true)
  assert.equal(originAllowed('http://127.0.0.1:1', { ...policy, loopbackBound: false }), false)
  assert.equal(originAllowed('https://evil.example', policy), false)
  assert.equal(originAllowed('null', policy), false)
})

function address(url: string): { port: number } {
  return { port: Number(new URL(url).port) }
}
