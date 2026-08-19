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

test('S3EvidenceSink calls PutObject with correct SigV4 signature', async () => {
  const { S3EvidenceSink } = await import('./evidence-sink')
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

  let capturedUrl = ''
  let capturedHeaders: Record<string, string> = {}
  let capturedBody = ''

  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    if (init?.headers) {
      capturedHeaders = init.headers as Record<string, string>
    }
    if (init?.body) {
      capturedBody = init.body as string
    }
    return new Response('', { status: 200 })
  }

  const sink = new S3EvidenceSink({
    endpoint: 'http://127.0.0.1:3902',
    region: 'local',
    bucket: 'evidence',
    accessKeyId: 'GK1234',
    secretAccessKey: 'secret',
    forcePathStyle: true,
  })

  const receipt = await sink.append(mockEvent)

  assert.ok(capturedUrl.includes('/evidence/evt_123.json'))
  assert.equal(capturedHeaders['content-type'], 'application/json')
  assert.ok(capturedHeaders['x-amz-date'])
  assert.ok(capturedHeaders['x-amz-content-sha256'])
  assert.ok(capturedHeaders['authorization'])
  assert.ok(capturedHeaders['authorization'].startsWith('AWS4-HMAC-SHA256'))
  assert.ok(capturedHeaders['authorization'].includes('Credential=GK1234'))
  assert.equal(JSON.parse(capturedBody).event_id, 'evt_123')
  assert.ok(receipt.store_uri.includes('evidence/evt_123.json'))
})

test('S3EvidenceSink uses prefix for object key', async () => {
  const { S3EvidenceSink } = await import('./evidence-sink')
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

  let capturedUrl = ''

  global.fetch = async (url: string | URL | Request) => {
    capturedUrl = String(url)
    return new Response('', { status: 200 })
  }

  const sink = new S3EvidenceSink({
    endpoint: 'http://127.0.0.1:3902',
    region: 'local',
    bucket: 'evidence',
    accessKeyId: 'GK1234',
    secretAccessKey: 'secret',
    prefix: 'hitly/',
    forcePathStyle: true,
  })

  const receipt = await sink.append(mockEvent)

  assert.ok(capturedUrl.includes('/evidence/hitly/evt_123.json'))
  assert.ok(receipt.store_uri.includes('evidence/hitly/evt_123.json'))
})

test('S3EvidenceSink throws on missing endpoint', async () => {
  const { createEvidenceSink } = await import('./evidence-sink')

  assert.throws(() => {
    createEvidenceSink({
      type: 's3',
      region: 'local',
      bucket: 'evidence',
      accessKeyId: 'GK1234',
      secretAccessKey: 'secret',
    })
  }, /Evidence sink S3 config missing required fields: endpoint/)
})

test('S3EvidenceSink throws on missing bucket', async () => {
  const { createEvidenceSink } = await import('./evidence-sink')

  assert.throws(() => {
    createEvidenceSink({
      type: 's3',
      endpoint: 'http://127.0.0.1:3902',
      region: 'local',
      accessKeyId: 'GK1234',
      secretAccessKey: 'secret',
    })
  }, /Evidence sink S3 config missing required fields: bucket/)
})

test('S3EvidenceSink throws on missing credentials', async () => {
  const { createEvidenceSink } = await import('./evidence-sink')

  assert.throws(() => {
    createEvidenceSink({
      type: 's3',
      endpoint: 'http://127.0.0.1:3902',
      region: 'local',
      bucket: 'evidence',
      secretAccessKey: 'secret',
    })
  }, /Evidence sink S3 config missing required fields: accessKeyId/)

  assert.throws(() => {
    createEvidenceSink({
      type: 's3',
      endpoint: 'http://127.0.0.1:3902',
      region: 'local',
      bucket: 'evidence',
      accessKeyId: 'GK1234',
    })
  }, /Evidence sink S3 config missing required fields: secretAccessKey/)
})

test('S3EvidenceSink handles PutObject error', async () => {
  const { S3EvidenceSink } = await import('./evidence-sink')
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_456',
    event_type: 'decided',
    seq: 2,
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

  global.fetch = async () => {
    return new Response('Bucket not found', { status: 404 })
  }

  const sink = new S3EvidenceSink({
    endpoint: 'http://127.0.0.1:3902',
    region: 'local',
    bucket: 'evidence',
    accessKeyId: 'GK1234',
    secretAccessKey: 'secret',
    forcePathStyle: true,
  })

  await assert.rejects(async () => {
    await sink.append(mockEvent)
  }, /Evidence sink S3 PutObject failed/)
})

test('S3EvidenceSink handles PutObject 5xx error', async () => {
  const { S3EvidenceSink } = await import('./evidence-sink')
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_456',
    approval_id: 'apr_789',
    event_type: 'decided',
    seq: 2,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_abc',
      runId: 'run_def',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'def456',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash_2',
    },
  }

  global.fetch = async () => {
    return new Response('Internal Server Error', { status: 500 })
  }

  const sink = new S3EvidenceSink({
    endpoint: 'http://127.0.0.1:3902',
    region: 'local',
    bucket: 'evidence',
    accessKeyId: 'GK1234',
    secretAccessKey: 'secret',
    forcePathStyle: true,
  })

  await assert.rejects(async () => {
    await sink.append(mockEvent)
  }, /Evidence sink S3 PutObject failed \(500\)/)
})

test('S3EvidenceSink defaults to path-style for non-AWS endpoints', async () => {
  const { S3EvidenceSink } = await import('./evidence-sink')
  const mockEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_789',
    approval_id: 'apr_012',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_xyz',
      runId: 'run_uvw',
    },
    action: {
      name: 'test',
      args: {},
      proposed_sha256: 'xyz789',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash_3',
    },
  }

  let capturedUrl = ''

  global.fetch = async (url: string | URL | Request) => {
    capturedUrl = String(url)
    return new Response('', { status: 200 })
  }

  const sink = new S3EvidenceSink({
    endpoint: 'http://127.0.0.1:3902',
    region: 'local',
    bucket: 'evidence',
    accessKeyId: 'GK1234',
    secretAccessKey: 'secret',
  })

  await sink.append(mockEvent)

  assert.ok(capturedUrl.includes('127.0.0.1:3902/evidence/evt_789.json'), `Expected path-style URL, got: ${capturedUrl}`)
  assert.ok(!capturedUrl.includes('evidence.127.0.0.1'), `Should not use virtual-host style, got: ${capturedUrl}`)
})
