import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jcsHash } from '@hitly/core'
import {
  createOnceCutoff,
  createOncePolicy,
  createOnceRetentionDays,
  DEFAULT_CREATE_ONCE_RETENTION_DAYS,
  envelopePayloadHash,
  payloadHashInput,
  withinCreateOnceWindow,
} from './create-once'

/** Fully populated ingested envelope so JSON round-trip keeps every hashed field. */
function populatedIngestedEnvelope(overrides?: Record<string, unknown>) {
  return {
    action: { name: 'pay', args: { amount: 100, currency: 'EUR' } },
    allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false, cancel: false },
    reasonRequired: ['reject'],
    contextMarkdown: 'Review this payment',
    metadata: { ticket: 'T-1' },
    externalUrls: [{ url: 'https://example.com/ticket/T-1', label: 'ticket' }],
    attachments: [{ name: 'invoice.pdf', url: 'https://example.com/invoice.pdf', contentType: 'application/pdf' }],
    resumeSchema: { type: 'object' },
    expiresAt: '2026-12-01T00:00:00.000Z',
    editableFields: { amount: { type: 'int' as const, min: 1 } },
    editReason: { text: { required: true, maxLength: 200 } },
    traceId: 'trace-1',
    spanId: 'span-1',
    agentId: 'agent-1',
    systemId: 'payments-agent',
    inventoryId: 'inv-1',
    policyId: 'pol-1',
    policyRationale: 'High-value transfer',
    riskTier: 'high',
    toolName: 'createPayment',
    sensitivity: ['pii'],
    dataCategories: ['financial'],
    origin: {
      plugin: 'mastra',
      projectId: 'prj_test',
      runId: 'run_test',
      stepId: 'step_test',
      resumeHandle: {
        mastraBaseUrl: 'https://origin.example/api',
        kind: 'workflow',
        workflowId: 'wf-pay',
        runId: 'run_test',
        stepId: 'step_test',
      },
      details: { kind: 'workflow', workflowId: 'wf-pay', stepId: 'step_test', runId: 'run_test' },
      traceId: 'trace-1',
      spanId: 'span-1',
      agentId: 'agent-1',
      systemId: 'payments-agent',
      inventoryId: 'inv-1',
      policyId: 'pol-1',
      policyRationale: 'High-value transfer',
      riskTier: 'high',
      toolName: 'createPayment',
    },
    ...overrides,
  }
}

const PAYLOAD_HASH_ENVELOPE_KEYS = [
  'action',
  'agentId',
  'allowedActions',
  'attachments',
  'contextMarkdown',
  'dataCategories',
  'editReason',
  'editableFields',
  'expiresAt',
  'externalUrls',
  'inventoryId',
  'metadata',
  'origin',
  'policyId',
  'policyRationale',
  'reasonRequired',
  'resumeSchema',
  'riskTier',
  'sensitivity',
  'spanId',
  'systemId',
  'toolName',
  'traceId',
] as const

const PAYLOAD_HASH_ORIGIN_KEYS = [
  'agentId',
  'details',
  'inventoryId',
  'plugin',
  'policyId',
  'policyRationale',
  'projectId',
  'resumeHandle',
  'riskTier',
  'runId',
  'spanId',
  'stepId',
  'systemId',
  'toolName',
  'traceId',
] as const

const FORBIDDEN_HASH_KEYS = [
  'Authorization',
  'authorization',
  'Bearer',
  'Cookie',
  'cookie',
  'Set-Cookie',
  'Idempotency-Key',
  'idempotency-key',
  'Content-Type',
  'x-hitly-client',
  'x-api-key',
  'apiKey',
  'hashedKey',
  'resumeSecret',
  'password',
]

function ownKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as Record<string, unknown>).sort()
}

const DAY = 24 * 60 * 60 * 1000

test('create-once retention: default is 10 days and is published in seconds', () => {
  assert.equal(DEFAULT_CREATE_ONCE_RETENTION_DAYS, 10)
  assert.equal(createOnceRetentionDays({}), 10)
  assert.deepEqual(createOncePolicy({}), { retentionSeconds: 10 * 24 * 60 * 60 })
})

test('create-once retention: env override accepts whole days 1-3650 only', () => {
  assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: '30' }), 30)
  assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: ' 1 ' }), 1)
  assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: '3650' }), 3650)
  for (const bad of ['0', '3651', '-1', '1.5', 'abc', '', '1e3']) {
    assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: bad }), 10, bad)
  }
  assert.deepEqual(createOncePolicy({ HITLY_CREATE_ONCE_RETENTION_DAYS: '2' }), { retentionSeconds: 2 * 86400 })
})

test('create-once window boundary: the cutoff instant is outside, 1 ms later is inside', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0)
  const cutoff = createOnceCutoff(now, {})
  assert.equal(cutoff.getTime(), now - 10 * DAY)
  assert.equal(withinCreateOnceWindow(new Date(now - 10 * DAY), now, {}), false)
  assert.equal(withinCreateOnceWindow(new Date(now - 10 * DAY + 1), now, {}), true)
  assert.equal(withinCreateOnceWindow(new Date(now - 10 * DAY - 1), now, {}), false)
  assert.equal(withinCreateOnceWindow(new Date(now), now, {}), true)
  const env = { HITLY_CREATE_ONCE_RETENTION_DAYS: '1' }
  assert.equal(withinCreateOnceWindow(new Date(now - DAY + 1), now, env), true)
  assert.equal(withinCreateOnceWindow(new Date(now - DAY), now, env), false)
})

test('payloadHashInput: exact key set of a fully populated ingested envelope', () => {
  const hashed = payloadHashInput(populatedIngestedEnvelope()) as Record<string, unknown>
  assert.deepEqual(ownKeys(hashed), [...PAYLOAD_HASH_ENVELOPE_KEYS])
  assert.deepEqual(ownKeys(hashed.origin), [...PAYLOAD_HASH_ORIGIN_KEYS])
  assert.equal('expiresAt' in hashed, true)
  assert.equal('origin' in hashed, true)
  for (const key of FORBIDDEN_HASH_KEYS) {
    assert.equal(key in hashed, false, `hashed input must not include ${key}`)
    assert.equal(key in (hashed.origin as object), false, `origin must not include ${key}`)
  }
})

test('payloadHash: origin is in the hash (same envelope, different origin -> different hash)', async () => {
  const base = populatedIngestedEnvelope()
  const otherOrigin = populatedIngestedEnvelope({
    origin: {
      ...(base.origin as Record<string, unknown>),
      runId: 'run_other',
    },
  })
  const left = await envelopePayloadHash(base)
  const right = await envelopePayloadHash(otherOrigin)
  assert.notEqual(left, right)
  assert.equal(left, await jcsHash(JSON.parse(JSON.stringify(base))))
})

test('payloadHash: expiresAt is in the hash (same envelope, different expiresAt -> different hash)', async () => {
  const base = populatedIngestedEnvelope({ expiresAt: '2026-12-01T00:00:00.000Z' })
  const otherExpiry = populatedIngestedEnvelope({ expiresAt: '2026-12-02T00:00:00.000Z' })
  const left = await envelopePayloadHash(base)
  const right = await envelopePayloadHash(otherExpiry)
  assert.notEqual(left, right)
  assert.equal(left, await jcsHash(JSON.parse(JSON.stringify(base))))
})

test('payloadHash: injecting Authorization (or other auth headers) is not part of the hashed input', async () => {
  const base = populatedIngestedEnvelope()
  const hashed = payloadHashInput(base) as Record<string, unknown>
  assert.deepEqual(ownKeys(hashed), [...PAYLOAD_HASH_ENVELOPE_KEYS])
  assert.equal(await envelopePayloadHash(base), await jcsHash(JSON.parse(JSON.stringify(base))))
  assert.equal(await envelopePayloadHash(base), await jcsHash(hashed))
  // A wrapper that injects Authorization into the JCS input must not match production.
  const injected = { ...(hashed as Record<string, unknown>), Authorization: 'Bearer should-not-be-hashed' }
  assert.notEqual(await envelopePayloadHash(base), await jcsHash(injected))
})
