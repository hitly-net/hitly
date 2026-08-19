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
