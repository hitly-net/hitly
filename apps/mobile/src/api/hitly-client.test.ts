import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHitlyClient } from './hitly-client'

test('decide 500 throws error (not success)', async () => {
  const mockFetch = async (url: string, init?: RequestInit) => {
    if (url.includes('/decide')) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Evidence sink append failed (fail-closed): connection timeout' }),
      } as Response
    }
    throw new Error('Unexpected URL')
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  await assert.rejects(
    async () => {
      await client.decide('apr_123', { decision: 'accept' })
    },
    { message: /Evidence sink append failed/ },
  )
})

test('approval 404 throws error', async () => {
  const mockFetch = async (url: string) => {
    if (url.includes('/approvals/')) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      } as Response
    }
    throw new Error('Unexpected URL')
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token', workspaceId: 'ws_123' })
  await assert.rejects(
    async () => {
      await client.approval('apr_other_workspace')
    },
    { message: /Not found/ },
  )
})

test('inbox sends scope=open query param', async () => {
  let capturedUrl: string | undefined
  const mockFetch = async (url: string) => {
    capturedUrl = url
    if (url.includes('/inbox')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [], nextCursor: null }),
      } as Response
    }
    throw new Error('Unexpected URL')
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  await client.inbox({ scope: 'open' })
  assert.ok(capturedUrl?.includes('scope=open'), 'Should include scope=open in query')
})

test('Temporal PATCH has address/namespace/taskQueue and no token', async () => {
  let capturedBody: string | undefined
  const mockFetch = async (url: string, init?: RequestInit) => {
    if (url.includes('/projects/') && init?.method === 'PATCH') {
      capturedBody = init.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response
    }
    throw new Error('Unexpected URL')
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  await client.updateProjectConfig('prj_temporal', {
    address: 'temporal.example.com:7233',
    namespace: 'default',
    taskQueue: 'approvals',
  })
  assert.ok(capturedBody, 'Body should be captured')
  const parsed = JSON.parse(capturedBody)
  assert.equal(parsed.address, 'temporal.example.com:7233')
  assert.equal(parsed.namespace, 'default')
  assert.equal(parsed.taskQueue, 'approvals')
  assert.equal(parsed.token, undefined, 'Temporal config should not have token')
})

test('LangGraph PATCH uses baseUrl/token, not taskQueue', async () => {
  let capturedBody: string | undefined
  const mockFetch = async (url: string, init?: RequestInit) => {
    if (url.includes('/projects/') && init?.method === 'PATCH') {
      capturedBody = init.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response
    }
    throw new Error('Unexpected URL')
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  await client.updateProjectConfig('prj_langgraph', {
    baseUrl: 'https://langgraph.example.com',
    token: 'lg_secret_123',
  })
  assert.ok(capturedBody, 'Body should be captured')
  const parsed = JSON.parse(capturedBody)
  assert.equal(parsed.baseUrl, 'https://langgraph.example.com')
  assert.equal(parsed.token, 'lg_secret_123')
  assert.equal(parsed.taskQueue, undefined, 'LangGraph config should not have taskQueue')
  assert.equal(parsed.address, undefined, 'LangGraph config should not have address')
  assert.equal(parsed.namespace, undefined, 'LangGraph config should not have namespace')
})

test('presented() POSTs /api/v1/approvals/:id/presented', async () => {
  let capturedUrl: string | undefined
  let capturedInit: RequestInit | undefined
  const mockFetch = async (url: string, init?: RequestInit) => {
    capturedUrl = url
    capturedInit = init
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'apr_123', presentedAt: '2026-10-30T09:00:00.000Z' }),
    } as Response
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  const result = await client.presented('apr_123')
  assert.ok(capturedUrl?.endsWith('/api/v1/approvals/apr_123/presented'), `URL was ${capturedUrl}`)
  assert.equal(capturedInit?.method, 'POST')
  assert.equal(result.presentedAt, '2026-10-30T09:00:00.000Z')
})

test('presented() surfaces server errors so callers can swallow them', async () => {
  const mockFetch = async (_url: string, _init?: RequestInit) => {
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as Response
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  await assert.rejects(() => client.presented('apr_123'), { message: /boom/ })
})

test('x-hitly-client header carries platform and appVersion when provided', async () => {
  let capturedHeaders: Record<string, string> | undefined
  const mockFetch = async (_url: string, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>
    return { ok: true, status: 200, json: async () => ({ id: 'apr_1', presentedAt: null }) } as Response
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({
    baseUrl: 'http://localhost:3001',
    token: 'test-token',
    platform: 'ios',
    appVersion: '2.1.0',
  })
  await client.presented('apr_1')
  assert.equal(capturedHeaders?.['x-hitly-client'], 'hitly-mobile/2.1.0 (ios)')

  // Without platform/appVersion the header is omitted entirely.
  capturedHeaders = undefined
  const plain = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  await plain.presented('apr_1')
  assert.equal(capturedHeaders?.['x-hitly-client'], undefined)
})
