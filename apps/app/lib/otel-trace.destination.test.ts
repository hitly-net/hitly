import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { ApprovalEnvelope, EvidenceEvent, OriginRef } from '@hitly/core'
import { exportOtelTrace } from './otel-trace'
import {
  CANARY,
  DEVELOPMENT,
  PRODUCTION,
  PRODUCTION_ALLOWED,
  captureConsole,
  startStub,
  withEnv,
  type StubServer,
} from './destination-test-helpers'

/**
 * OTEL endpoints go through the destination check at send time.
 * Run with: yarn workspace @hitly/app test
 */

const envelope: ApprovalEnvelope = {
  action: { name: 'send_refund', args: { amount: 1 } },
  allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
  contextMarkdown: 'ctx',
  traceId: '12345678901234567890123456789012',
  spanId: '1234567890123456',
}

const origin: OriginRef = {
  plugin: 'mastra',
  projectId: 'prj_1',
  runId: 'run_1',
  stepId: 'step_1',
  resumeHandle: {},
  traceId: '12345678901234567890123456789012',
  spanId: '1234567890123456',
}

const event: EvidenceEvent = {
  spec: 'hitly.evidence.v1',
  event_id: 'evt_otel_1',
  approval_id: 'apr_1',
  event_type: 'requested',
  seq: 1,
  occurred_at: '2026-01-01T00:00:00.000Z',
  origin: { plugin: 'mastra', projectId: 'prj_1', runId: 'run_1', stepId: 'step_1' },
  action: { name: 'send_refund', args: { amount: 1 }, proposed_sha256: 'abc' },
  retention: { min_days: 180 },
  integrity: { alg: 'sha256', content_sha256: 'def' },
}

let ok: StubServer
let failing: StubServer
let redirecting: StubServer
let target: StubServer

before(async () => {
  ok = await startStub((_req, res) => res.end('{}'))
  failing = await startStub((_req, res) => {
    res.writeHead(500, CANARY.slice(0, 20))
    res.end(CANARY)
  })
  target = await startStub((_req, res) => res.end('{}'))
  redirecting = await startStub((_req, res) => {
    res.writeHead(307, { location: `${target.url}/v1/traces` })
    res.end(CANARY)
  })
})

after(() => {
  for (const s of [ok, failing, redirecting, target]) s.close()
})

function exportTo(endpoint: string) {
  return captureConsole(() =>
    exportOtelTrace({
      event,
      envelope,
      origin,
      workspaceId: 'wks_1',
      loadEndpoints: async () => [{ name: 'Local collector', endpoint, protocol: 'http/json', enabled: true }],
    }),
  )
}

describe('OTEL endpoint destination check', () => {
  it('refuses a 127.0.0.1 endpoint in production without the flag and names the flag', async () => {
    const before = ok.hits.length
    const { output } = await withEnv(PRODUCTION, () => exportTo(`${ok.url}/v1/traces`))
    assert.equal(ok.hits.length, before)
    assert.ok(output.includes('HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS'))
  })

  it('still refuses with the flag set to "1"', async () => {
    const before = ok.hits.length
    await withEnv({ NODE_ENV: 'production', HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS: '1' }, () => exportTo(`${ok.url}/v1/traces`))
    assert.equal(ok.hits.length, before)
  })

  it('exports to a 127.0.0.1 endpoint in production with the flag set to "true"', async () => {
    const before = ok.hits.length
    await withEnv(PRODUCTION_ALLOWED, () => exportTo(`${ok.url}/v1/traces`))
    assert.equal(ok.hits.length, before + 1)
  })

  it('exports to a 127.0.0.1 endpoint outside production', async () => {
    const before = ok.hits.length
    await withEnv(DEVELOPMENT, () => exportTo(`${ok.url}/v1/traces`))
    assert.equal(ok.hits.length, before + 1)
  })

  it('does not follow redirects', async () => {
    const before = target.hits.length
    const { output } = await withEnv(DEVELOPMENT, () => exportTo(`${redirecting.url}/v1/traces`))
    assert.equal(target.hits.length, before)
    assert.ok(output.includes('redirects are not followed'))
  })

  it('logs status and host only, never the response body or status text', async () => {
    const { output } = await withEnv(DEVELOPMENT, () => exportTo(`${failing.url}/v1/traces?key=k1`))
    assert.ok(output.includes('500'))
    assert.ok(!output.includes(CANARY))
    assert.ok(!output.includes(CANARY.slice(0, 20)))
    assert.ok(!output.includes('key=k1'))
  })
})
