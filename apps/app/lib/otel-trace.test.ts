import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalEnvelope, DecisionPayload, EvidenceEvent, OriginRef } from '@hitly/core'
import { buildOtelSpan, exportOtelTrace } from './otel-trace'

describe('OTEL trace mapper', () => {
  const mockEnvelope: ApprovalEnvelope = {
    action: { name: 'send_refund', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
    contextMarkdown: 'Test context',
    traceId: '12345678901234567890123456789012',
    spanId: '1234567890123456',
    agentId: 'test-agent',
    systemId: 'test-system',
    riskTier: 'high',
  }

  const mockOrigin: OriginRef = {
    plugin: 'mastra',
    projectId: 'prj_123',
    runId: 'run_123',
    stepId: 'step_123',
    resumeHandle: {},
    traceId: '12345678901234567890123456789012',
    spanId: '1234567890123456',
  }

  const mockRequestedEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_123',
    approval_id: 'apr_123',
    event_type: 'requested',
    seq: 1,
    occurred_at: '2024-01-01T00:00:00.000Z',
    origin: {
      plugin: 'mastra',
      projectId: 'prj_123',
      runId: 'run_123',
      stepId: 'step_123',
    },
    agent: {
      agentId: 'test-agent',
      traceId: '12345678901234567890123456789012',
      spanId: '1234567890123456',
    },
    system: {
      systemId: 'test-system',
    },
    policy: {
      riskTier: 'high',
    },
    action: {
      name: 'send_refund',
      args: { amount: 100 },
      proposed_sha256: 'abc123',
    },
    retention: {
      min_days: 180,
    },
    integrity: {
      alg: 'sha256',
      content_sha256: 'def456',
    },
  }

  const mockDecidedEvent: EvidenceEvent = {
    ...mockRequestedEvent,
    event_id: 'evt_456',
    event_type: 'decided',
    seq: 2,
    oversight: {
      reviewer_id: 'usr_123',
      decision: 'accept',
      decided_at: '2024-01-01T00:01:00.000Z',
    },
    integrity: {
      alg: 'sha256',
      prev_event_id: 'evt_123',
      prev_content_sha256: 'def456',
      content_sha256: 'ghi789',
    },
  }

  const mockResumedEvent: EvidenceEvent = {
    ...mockRequestedEvent,
    event_id: 'evt_789',
    event_type: 'resumed',
    seq: 3,
    integrity: {
      alg: 'sha256',
      prev_event_id: 'evt_456',
      prev_content_sha256: 'ghi789',
      content_sha256: 'jkl012',
    },
  }

  const mockResumeFailedEvent: EvidenceEvent = {
    ...mockRequestedEvent,
    event_id: 'evt_999',
    event_type: 'resume_failed',
    seq: 4,
    integrity: {
      alg: 'sha256',
      prev_event_id: 'evt_456',
      prev_content_sha256: 'ghi789',
      content_sha256: 'mno345',
    },
  }

  it('should build OTEL span for requested event', () => {
    const trace = buildOtelSpan({
      event: mockRequestedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      workspaceId: 'wks_test',
    })

    assert.equal(trace.resourceSpans.length, 1)
    const resource = trace.resourceSpans[0]
    assert.ok(resource.resource.attributes.some(a => a.key === 'service.name' && a.value.stringValue === 'hitly'))
    assert.ok(resource.resource.attributes.some(a => a.key === 'hitly.workspace_id' && a.value.stringValue === 'wks_test'))
    assert.ok(resource.resource.attributes.some(a => a.key === 'hitly.project_id' && a.value.stringValue === 'prj_123'))

    const span = resource.scopeSpans[0].spans[0]
    assert.equal(span.name, 'hitly.approval.requested')
    assert.equal(span.traceId, '12345678901234567890123456789012')
    assert.equal(span.parentSpanId, '1234567890123456')

    const attrs = span.attributes
    assert.ok(attrs.some(a => a.key === 'hitly.approval_id' && a.value.stringValue === 'apr_123'))
    assert.ok(attrs.some(a => a.key === 'hitly.plugin' && a.value.stringValue === 'mastra'))
    assert.ok(attrs.some(a => a.key === 'hitly.action_name' && a.value.stringValue === 'send_refund'))
    assert.ok(attrs.some(a => a.key === 'hitly.status' && a.value.stringValue === 'requested'))
    assert.ok(attrs.some(a => a.key === 'hitly.agent_id' && a.value.stringValue === 'test-agent'))
    assert.ok(attrs.some(a => a.key === 'hitly.system_id' && a.value.stringValue === 'test-system'))
    assert.ok(attrs.some(a => a.key === 'hitly.risk_tier' && a.value.stringValue === 'high'))
  })

  it('should build OTEL span for decided event with decision attribute', () => {
    const payload: DecisionPayload = {
      decision: 'accept',
    }

    const trace = buildOtelSpan({
      event: mockDecidedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    assert.equal(span.name, 'hitly.approval.decided')

    const attrs = span.attributes
    assert.ok(attrs.some(a => a.key === 'hitly.decision' && a.value.stringValue === 'accept'))
    assert.ok(attrs.some(a => a.key === 'hitly.event_type' && a.value.stringValue === 'decided'))
  })

  it('should build OTEL span for resumed event', () => {
    const trace = buildOtelSpan({
      event: mockResumedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    assert.equal(span.name, 'hitly.approval.resumed')
    assert.ok(span.attributes.some(a => a.key === 'hitly.status' && a.value.stringValue === 'resumed'))
  })

  it('should build OTEL span for resume_failed event', () => {
    const trace = buildOtelSpan({
      event: mockResumeFailedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    assert.equal(span.name, 'hitly.approval.resume_failed')
    assert.ok(span.attributes.some(a => a.key === 'hitly.status' && a.value.stringValue === 'resume_failed'))
  })

  it('should not include raw action.args in span attributes', () => {
    const trace = buildOtelSpan({
      event: mockRequestedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    const attrs = span.attributes

    assert.ok(!attrs.some(a => a.key === 'action.args'))
    assert.ok(!attrs.some(a => a.key === 'hitly.action.args'))
    assert.ok(!attrs.some(a => a.value.stringValue?.includes('amount')))
    assert.ok(!attrs.some(a => a.value.stringValue?.includes('100')))
  })

  it('should generate trace ID when envelope/origin traceId is missing', () => {
    const envelopeWithoutTrace = { ...mockEnvelope, traceId: undefined }
    const originWithoutTrace = { ...mockOrigin, traceId: undefined }

    const trace = buildOtelSpan({
      event: mockRequestedEvent,
      envelope: envelopeWithoutTrace,
      origin: originWithoutTrace,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    assert.equal(typeof span.traceId, 'string')
    assert.equal(span.traceId.length, 32)
    assert.ok(/^[0-9a-f]{32}$/.test(span.traceId))
  })

  it('should not set parentSpanId when envelope/origin spanId is missing', () => {
    const envelopeWithoutSpan = { ...mockEnvelope, spanId: undefined }
    const originWithoutSpan = { ...mockOrigin, spanId: undefined }

    const trace = buildOtelSpan({
      event: mockRequestedEvent,
      envelope: envelopeWithoutSpan,
      origin: originWithoutSpan,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    assert.equal(span.parentSpanId, undefined)
  })

  it('should include content_sha256 attribute', () => {
    const trace = buildOtelSpan({
      event: mockRequestedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    assert.ok(span.attributes.some(a => a.key === 'hitly.content_sha256' && a.value.stringValue === 'def456'))
  })

  it('should include seq as int attribute', () => {
    const trace = buildOtelSpan({
      event: mockRequestedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      workspaceId: 'wks_test',
    })

    const span = trace.resourceSpans[0].scopeSpans[0].spans[0]
    assert.ok(span.attributes.some(a => a.key === 'hitly.seq' && a.value.intValue === '1'))
  })
})

describe('OTEL trace exporter', () => {
  const mockEnvelope: ApprovalEnvelope = {
    action: { name: 'send_refund', args: { amount: 100 } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
  }

  const mockOrigin: OriginRef = {
    plugin: 'mastra',
    projectId: 'prj_123',
    runId: 'run_123',
    resumeHandle: {},
  }

  const mockDecidedEvent: EvidenceEvent = {
    spec: 'hitly.evidence.v1',
    event_id: 'evt_456',
    approval_id: 'apr_123',
    event_type: 'decided',
    seq: 2,
    occurred_at: '2024-01-01T00:01:00.000Z',
    origin: { plugin: 'mastra', projectId: 'prj_123', runId: 'run_123' },
    agent: {},
    system: {},
    policy: {},
    action: { name: 'send_refund', args: { amount: 100 }, proposed_sha256: 'abc123' },
    oversight: { reviewer_id: 'usr_123', decision: 'accept', decided_at: '2024-01-01T00:01:00.000Z' },
    retention: { min_days: 180 },
    integrity: { alg: 'sha256', content_sha256: 'ghi789' },
  }

  const mockPayload: DecisionPayload = { decision: 'accept' }

  it('should not call fetch when endpoint list is empty', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mock.fn(() => Promise.resolve(new Response('', { status: 200 })))
    globalThis.fetch = fetchMock as any

    const dbMock = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    }

    const requireDbMock = () => dbMock
    const requireTenantWorkspaceIdMock = () => 'wks_123'

    mock.module('./tenant', () => ({
      requireDb: requireDbMock,
      requireTenantWorkspaceId: requireTenantWorkspaceIdMock,
    }))

    await exportOtelTrace({
      event: mockDecidedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload: mockPayload,
      workspaceId: 'wks_123',
    })

    assert.equal(fetchMock.mock.callCount(), 0, 'fetch should not be called when no endpoints are configured')

    globalThis.fetch = originalFetch
  })

  it('should send trace to both endpoints when two are enabled', async () => {
    const originalFetch = globalThis.fetch
    const fetchCalls: string[] = []
    const fetchMock = mock.fn((url: string) => {
      fetchCalls.push(url)
      return Promise.resolve(new Response('', { status: 200 }))
    })
    globalThis.fetch = fetchMock as any

    const dbMock = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                id: 'ote_1',
                workspaceId: 'wks_123',
                name: 'Endpoint 1',
                endpoint: 'http://endpoint1.test/v1/traces',
                protocol: 'http/json',
                headers: null,
                enabled: true,
              },
              {
                id: 'ote_2',
                workspaceId: 'wks_123',
                name: 'Endpoint 2',
                endpoint: 'http://endpoint2.test/v1/traces',
                protocol: 'http/json',
                headers: null,
                enabled: true,
              },
            ]),
        }),
      }),
    }

    const requireDbMock = () => dbMock
    const decodeTenantJsonMock = () => Promise.resolve({})

    mock.module('./tenant', () => ({
      requireDb: requireDbMock,
    }))

    mock.module('./tenant-crypto', () => ({
      decodeTenantJson: decodeTenantJsonMock,
    }))

    await exportOtelTrace({
      event: mockDecidedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload: mockPayload,
      workspaceId: 'wks_123',
    })

    assert.equal(fetchMock.mock.callCount(), 2, 'fetch should be called twice for two endpoints')
    assert.ok(fetchCalls.includes('http://endpoint1.test/v1/traces'), 'first endpoint should be called')
    assert.ok(fetchCalls.includes('http://endpoint2.test/v1/traces'), 'second endpoint should be called')

    globalThis.fetch = originalFetch
  })

  it('should not skip second endpoint when first returns 500', async () => {
    const originalFetch = globalThis.fetch
    const fetchCalls: { url: string; success: boolean }[] = []
    const fetchMock = mock.fn((url: string) => {
      const is500 = url.includes('endpoint1')
      fetchCalls.push({ url, success: !is500 })
      return Promise.resolve(new Response('', { status: is500 ? 500 : 200 }))
    })
    globalThis.fetch = fetchMock as any

    const dbMock = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                id: 'ote_1',
                workspaceId: 'wks_123',
                name: 'Endpoint 1',
                endpoint: 'http://endpoint1.test/v1/traces',
                protocol: 'http/json',
                headers: null,
                enabled: true,
              },
              {
                id: 'ote_2',
                workspaceId: 'wks_123',
                name: 'Endpoint 2',
                endpoint: 'http://endpoint2.test/v1/traces',
                protocol: 'http/json',
                headers: null,
                enabled: true,
              },
            ]),
        }),
      }),
    }

    const requireDbMock = () => dbMock
    const decodeTenantJsonMock = () => Promise.resolve({})

    mock.module('./tenant', () => ({
      requireDb: requireDbMock,
    }))

    mock.module('./tenant-crypto', () => ({
      decodeTenantJson: decodeTenantJsonMock,
    }))

    await exportOtelTrace({
      event: mockDecidedEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload: mockPayload,
      workspaceId: 'wks_123',
    })

    assert.equal(fetchMock.mock.callCount(), 2, 'fetch should be called twice even when first fails')
    assert.ok(fetchCalls.some(c => c.url.includes('endpoint1') && !c.success), 'first endpoint should fail')
    assert.ok(fetchCalls.some(c => c.url.includes('endpoint2') && c.success), 'second endpoint should succeed')

    globalThis.fetch = originalFetch
  })
})
