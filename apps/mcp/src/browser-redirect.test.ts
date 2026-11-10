import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MCP_DOCS_URL } from './server.ts'
import { startHarness, TEST_KEY } from './test-helpers.ts'

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
}

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

async function browserGet(url: string, headers: Record<string, string> = {}) {
  return fetch(url, { redirect: 'manual', headers })
}

async function rawPost(url: string, headers: Record<string, string>) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initialize),
  })
}

test('an unauthenticated browser GET of /mcp and /mcp/ redirects to the docs page', async () => {
  const h = await startHarness()
  try {
    for (const path of ['/mcp', '/mcp/']) {
      for (const accept of ['text/html', BROWSER_ACCEPT, 'Text/HTML']) {
        const res = await browserGet(`${h.url}${path}`, { accept })
        assert.equal(res.status, 302, `${path} with Accept: ${accept}`)
        assert.equal(res.headers.get('location'), MCP_DOCS_URL)
        assert.equal(MCP_DOCS_URL, 'https://hitly.net/docs/mcp')
      }
    }
    assert.equal(h.host.ingests.length, 0)
  } finally {
    await h.close()
  }
})

test('an unauthenticated POST /mcp still gets 401 with the Bearer challenge', async () => {
  const h = await startHarness()
  try {
    const res = await rawPost(h.url, {})
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/)
    const body = (await res.json()) as { error: { message: string } }
    assert.equal(body.error.message, 'Missing API key')
  } finally {
    await h.close()
  }
})

test('an MCP client GET with text/event-stream is never redirected', async () => {
  const h = await startHarness()
  try {
    const res = await browserGet(`${h.url}/mcp`, {
      accept: 'text/event-stream',
      authorization: `Bearer ${TEST_KEY}`,
    })
    assert.notEqual(res.status, 302)
    assert.equal(res.headers.get('location'), null)
    // Stateless server: GET has no SSE stream to open, so it stays 405 as before.
    assert.equal(res.status, 405)

    // Even a mixed browser-looking Accept that mentions event-stream is left alone.
    const mixed = await browserGet(`${h.url}/mcp`, { accept: `${BROWSER_ACCEPT}, text/event-stream` })
    assert.equal(mixed.status, 405)
  } finally {
    await h.close()
  }
})

test('a GET with Accept text/html but an Authorization header is not redirected', async () => {
  const h = await startHarness()
  try {
    for (const authorization of [`Bearer ${TEST_KEY}`, 'Bearer not-a-hitly-key']) {
      const res = await browserGet(`${h.url}/mcp`, { accept: 'text/html', authorization })
      assert.equal(res.status, 405, authorization)
      assert.equal(res.headers.get('location'), null)
    }
  } finally {
    await h.close()
  }
})

test('GET /healthz is unchanged', async () => {
  const h = await startHarness()
  try {
    const res = await fetch(`${h.url}/healthz`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
    // Even an html-accepting browser visit to /healthz is served, not redirected.
    const browser = await browserGet(`${h.url}/healthz`, { accept: 'text/html' })
    assert.equal(browser.status, 200)
  } finally {
    await h.close()
  }
})
