import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApprovalEnvelope, DecisionPayload, EvidenceEvent, OriginRef } from '@hitly/core'
import { buildOtelSpan, exportOtelTrace, type OtelEndpointConfig } from './otel-trace'
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

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
  const origFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  function stubFetch(handler: (url: string) => { status: number }) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      const { status } = handler(url)
      return new Response('', { status }) as Response
    }) as typeof fetch
    return calls
  }

  it('should not fetch when endpoint list is empty', async () => {
    const calls = stubFetch(() => ({ status: 200 }))

    const mockEnvelope: ApprovalEnvelope = {
      action: { name: 'test_action', args: {} },
      allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
      contextMarkdown: 'Test',
    }

    const mockOrigin: OriginRef = {
      plugin: 'http',
      projectId: 'prj_test',
      runId: 'run_test',
      stepId: 'step_test',
      resumeHandle: {},
    }

    const mockEvent: EvidenceEvent = {
      spec: 'hitly.evidence.v1',
      event_id: 'evt_test',
      approval_id: 'apr_test',
      event_type: 'decided',
      seq: 2,
      occurred_at: '2024-01-01T00:01:00.000Z',
      origin: { plugin: 'http', projectId: 'prj_test', runId: 'run_test', stepId: 'step_test' },
      action: { name: 'test_action', args: {}, proposed_sha256: 'abc' },
      oversight: { reviewer_id: 'usr_123', decision: 'accept', decided_at: '2024-01-01T00:01:00.000Z' },
      retention: { min_days: 180 },
      integrity: { alg: 'sha256', prev_event_id: 'evt_prev', prev_content_sha256: 'prev', content_sha256: 'def' },
    }

    await exportOtelTrace({
      event: mockEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload: { decision: 'accept' },
      workspaceId: 'wks_test',
      loadEndpoints: async () => [],
    })

    assert.equal(calls.length, 0, 'No fetch should be called with empty endpoint list')
  })

  it('should send same decide span to two endpoints', async () => {
    const calls = stubFetch(() => ({ status: 200 }))

    const mockEnvelope: ApprovalEnvelope = {
      action: { name: 'test_action', args: {} },
      allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
      contextMarkdown: 'Test',
    }

    const mockOrigin: OriginRef = {
      plugin: 'http',
      projectId: 'prj_test',
      runId: 'run_test',
      stepId: 'step_test',
      resumeHandle: {},
    }

    const mockEvent: EvidenceEvent = {
      spec: 'hitly.evidence.v1',
      event_id: 'evt_test',
      approval_id: 'apr_test',
      event_type: 'decided',
      seq: 2,
      occurred_at: '2024-01-01T00:01:00.000Z',
      origin: { plugin: 'http', projectId: 'prj_test', runId: 'run_test', stepId: 'step_test' },
      action: { name: 'test_action', args: {}, proposed_sha256: 'abc' },
      oversight: { reviewer_id: 'usr_123', decision: 'accept', decided_at: '2024-01-01T00:01:00.000Z' },
      retention: { min_days: 180 },
      integrity: { alg: 'sha256', prev_event_id: 'evt_prev', prev_content_sha256: 'prev', content_sha256: 'def' },
    }

    await exportOtelTrace({
      event: mockEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload: { decision: 'accept' },
      workspaceId: 'wks_test',
      loadEndpoints: async () => [
        {
          name: 'Endpoint 1',
          endpoint: 'http://endpoint1.test/v1/traces',
          protocol: 'http/json',
          enabled: true,
        },
        {
          name: 'Endpoint 2',
          endpoint: 'http://endpoint2.test/v1/traces',
          protocol: 'http/json',
          enabled: true,
        },
      ],
    })

    assert.equal(calls.length, 2, 'Both endpoints should be called')
    assert.ok(calls[0].url.includes('endpoint1.test'), 'First endpoint URL should match')
    assert.ok(calls[1].url.includes('endpoint2.test'), 'Second endpoint URL should match')

    // Both bodies should contain the decide span name
    const body1 = Buffer.from(calls[0].init.body as Uint8Array).toString('utf8')
    const body2 = Buffer.from(calls[1].init.body as Uint8Array).toString('utf8')
    assert.ok(body1.includes('hitly.approval.decided'), 'First body should contain decide span name')
    assert.ok(body2.includes('hitly.approval.decided'), 'Second body should contain decide span name')
  })

  it('should not skip second endpoint when first returns 500', async () => {
    const calls = stubFetch((url: string) => {
      if (url.includes('fail.test')) {
        return { status: 500 }
      }
      return { status: 200 }
    })

    const mockEnvelope: ApprovalEnvelope = {
      action: { name: 'test_action', args: {} },
      allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
      contextMarkdown: 'Test',
    }

    const mockOrigin: OriginRef = {
      plugin: 'http',
      projectId: 'prj_test',
      runId: 'run_test',
      stepId: 'step_test',
      resumeHandle: {},
    }

    const mockEvent: EvidenceEvent = {
      spec: 'hitly.evidence.v1',
      event_id: 'evt_test',
      approval_id: 'apr_test',
      event_type: 'decided',
      seq: 2,
      occurred_at: '2024-01-01T00:01:00.000Z',
      origin: { plugin: 'http', projectId: 'prj_test', runId: 'run_test', stepId: 'step_test' },
      action: { name: 'test_action', args: {}, proposed_sha256: 'abc' },
      oversight: { reviewer_id: 'usr_123', decision: 'accept', decided_at: '2024-01-01T00:01:00.000Z' },
      retention: { min_days: 180 },
      integrity: { alg: 'sha256', prev_event_id: 'evt_prev', prev_content_sha256: 'prev', content_sha256: 'def' },
    }

    await exportOtelTrace({
      event: mockEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload: { decision: 'accept' },
      workspaceId: 'wks_test',
      loadEndpoints: async () => [
        {
          name: 'Failing Endpoint',
          endpoint: 'http://fail.test/v1/traces',
          protocol: 'http/json',
          enabled: true,
        },
        {
          name: 'Healthy Endpoint',
          endpoint: 'http://healthy.test/v1/traces',
          protocol: 'http/json',
          enabled: true,
        },
      ],
    })

    assert.equal(calls.length, 2, 'Both endpoints should be called despite 500')
    assert.ok(calls.some(c => c.url.includes('fail.test')), 'Failing endpoint should be called')
    assert.ok(calls.some(c => c.url.includes('healthy.test')), 'Healthy endpoint should be called')
  })

  it('should send binary protobuf (not JSON) for http/protobuf protocol', async () => {
    const calls = stubFetch(() => ({ status: 200 }))

    const mockEnvelope: ApprovalEnvelope = {
      action: { name: 'test_action', args: {} },
      allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
      contextMarkdown: 'Test',
    }

    const mockOrigin: OriginRef = {
      plugin: 'http',
      projectId: 'prj_test',
      runId: 'run_test',
      stepId: 'step_test',
      resumeHandle: {},
    }

    const mockEvent: EvidenceEvent = {
      spec: 'hitly.evidence.v1',
      event_id: 'evt_test',
      approval_id: 'apr_test',
      event_type: 'decided',
      seq: 2,
      occurred_at: '2024-01-01T00:01:00.000Z',
      origin: { plugin: 'http', projectId: 'prj_test', runId: 'run_test', stepId: 'step_test' },
      action: { name: 'test_action', args: {}, proposed_sha256: 'abc' },
      oversight: { reviewer_id: 'usr_123', decision: 'accept', decided_at: '2024-01-01T00:01:00.000Z' },
      retention: { min_days: 180 },
      integrity: { alg: 'sha256', prev_event_id: 'evt_prev', prev_content_sha256: 'prev', content_sha256: 'def' },
    }

    await exportOtelTrace({
      event: mockEvent,
      envelope: mockEnvelope,
      origin: mockOrigin,
      payload: { decision: 'accept' },
      workspaceId: 'wks_test',
      loadEndpoints: async () => [
        {
          name: 'Protobuf Endpoint',
          endpoint: 'http://protobuf.test/v1/traces',
          protocol: 'http/protobuf',
          enabled: true,
        },
      ],
    })

    assert.equal(calls.length, 1, 'One endpoint should be called')

    const body = calls[0].init.body
    assert.ok(Buffer.isBuffer(body) || body instanceof Uint8Array, 'Body should be binary')

    const contentType = (calls[0].init.headers as Record<string, string>)?.['Content-Type']
    assert.equal(contentType, 'application/x-protobuf', 'Content-Type should be application/x-protobuf')

    // Assert body is NOT JSON
    const bodyBuffer = Buffer.from(body as Uint8Array)
    assert.notEqual(bodyBuffer.subarray(0, 1)[0], 0x7b, 'Body should not start with { (0x7b)')

    let jsonParseThrew = false
    try {
      JSON.parse(bodyBuffer.toString('utf8'))
    } catch {
      jsonParseThrew = true
    }
    assert.ok(jsonParseThrew, 'Body should not be parseable as JSON')
  })
})
