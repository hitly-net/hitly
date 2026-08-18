import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpEvidenceSink } from './evidence-sink'
import type { EvidenceEvent } from '@hitly/core'

test('HttpEvidenceSink sends custom headers', async () => {
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_456',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_789',
      runId: 'run_abc',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'abc123',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash',
    },
  }

  let capturedHeaders: Record<string, string> = {}
  let capturedBody = ''

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.headers) {
      capturedHeaders = init.headers as Record<string, string>
    }
    if (init?.body) {
      capturedBody = init.body as string
    }
    return new Response(JSON.stringify({
      event_id: mockEvent.event_id,
      content_sha256: mockEvent.integrity.content_sha256,
      store_uri: 'https://example.com/evt_123',
      stored_at: '2024-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const sink = new HttpEvidenceSink({
    url: 'https://example.com/evidence',
    headers: {
      'X-Custom-Header': 'custom-value',
      'X-Store-Token': 'secret123',
    },
  })

  await sink.append(mockEvent)

  assert.equal(capturedHeaders['content-type'], 'application/json')
  assert.equal(capturedHeaders['idempotency-key'], 'evt_123')
  assert.equal(capturedHeaders['X-Custom-Header'], 'custom-value')
  assert.equal(capturedHeaders['X-Store-Token'], 'secret123')
})

test('HttpEvidenceSink sends X-Hitly-Metadata header when metadata is provided', async () => {
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_456',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_789',
      runId: 'run_abc',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'abc123',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash',
    },
  }

  let capturedHeaders: Record<string, string> = {}

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.headers) {
      capturedHeaders = init.headers as Record<string, string>
    }
    return new Response(JSON.stringify({
      event_id: mockEvent.event_id,
      content_sha256: mockEvent.integrity.content_sha256,
      store_uri: 'https://example.com/evt_123',
      stored_at: '2024-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const sink = new HttpEvidenceSink({
    url: 'https://example.com/evidence',
    metadata: {
      tenant: 'acme',
      bucket: 'audit',
    },
  })

  await sink.append(mockEvent)

  assert.equal(capturedHeaders['X-Hitly-Metadata'], JSON.stringify({ tenant: 'acme', bucket: 'audit' }))
})

test('HttpEvidenceSink does not merge metadata into event body', async () => {
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_456',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_789',
      runId: 'run_abc',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'abc123',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash',
    },
  }

  let capturedBody = ''

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) {
      capturedBody = init.body as string
    }
    return new Response(JSON.stringify({
      event_id: mockEvent.event_id,
      content_sha256: mockEvent.integrity.content_sha256,
      store_uri: 'https://example.com/evt_123',
      stored_at: '2024-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const sink = new HttpEvidenceSink({
    url: 'https://example.com/evidence',
    metadata: {
      tenant: 'acme',
      bucket: 'audit',
    },
  })

  await sink.append(mockEvent)

  const sentEvent = JSON.parse(capturedBody)
  assert.equal(sentEvent.tenant, undefined)
  assert.equal(sentEvent.bucket, undefined)
  assert.equal(sentEvent.metadata, undefined)
  assert.equal(sentEvent.event_id, 'evt_123')
  assert.equal(sentEvent.integrity.content_sha256, 'test_hash')
})

test('HttpEvidenceSink does not override content-type and idempotency-key', async () => {
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_456',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_789',
      runId: 'run_abc',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'abc123',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash',
    },
  }

  let capturedHeaders: Record<string, string> = {}

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.headers) {
      capturedHeaders = init.headers as Record<string, string>
    }
    return new Response(JSON.stringify({
      event_id: mockEvent.event_id,
      content_sha256: mockEvent.integrity.content_sha256,
      store_uri: 'https://example.com/evt_123',
      stored_at: '2024-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const sink = new HttpEvidenceSink({
    url: 'https://example.com/evidence',
    headers: {
      'content-type': 'text/plain',
      'idempotency-key': 'should-be-ignored',
    },
  })

  await sink.append(mockEvent)

  assert.equal(capturedHeaders['content-type'], 'application/json')
  assert.equal(capturedHeaders['idempotency-key'], 'evt_123')
})

test('HttpEvidenceSink authHeader overrides custom authorization header', async () => {
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_456',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_789',
      runId: 'run_abc',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'abc123',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash',
    },
  }

  let capturedHeaders: Record<string, string> = {}

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.headers) {
      capturedHeaders = init.headers as Record<string, string>
    }
    return new Response(JSON.stringify({
      event_id: mockEvent.event_id,
      content_sha256: mockEvent.integrity.content_sha256,
      store_uri: 'https://example.com/evt_123',
      stored_at: '2024-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const sink = new HttpEvidenceSink({
    url: 'https://example.com/evidence',
    authHeader: 'Bearer correct-token',
    headers: {
      authorization: 'Bearer wrong-token',
    },
  })

  await sink.append(mockEvent)

  assert.equal(capturedHeaders.authorization, 'Bearer correct-token')
})

test('HttpEvidenceSink skips empty metadata object', async () => {
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_456',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_789',
      runId: 'run_abc',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'abc123',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash',
    },
  }

  let capturedHeaders: Record<string, string> = {}

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.headers) {
      capturedHeaders = init.headers as Record<string, string>
    }
    return new Response(JSON.stringify({
      event_id: mockEvent.event_id,
      content_sha256: mockEvent.integrity.content_sha256,
      store_uri: 'https://example.com/evt_123',
      stored_at: '2024-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const sink = new HttpEvidenceSink({
    url: 'https://example.com/evidence',
    metadata: {},
  })

  await sink.append(mockEvent)

  assert.equal(capturedHeaders['X-Hitly-Metadata'], undefined)
})
