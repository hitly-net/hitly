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
    prompt: 'Which venue?',
    answerSchema: { type: 'single', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], bounds: { minItems: 1 } },
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
  'answerSchema',
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
  'prompt',
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

test('create-once covers a persisted answerSchema: asks differing only in type/options/bounds get different payloadHashes', async () => {
  // The stored envelope IS the hash input, so a persisted answerSchema is
  // automatically covered: two MCP ask_user calls with identical
  // prompt/contextMarkdown that differ only in type, options or bounds must
  // NOT collapse to the same payloadHash (they would 409 idempotency_conflict
  // at the route instead of silently replaying the first ask's widget).
  const base = {
    action: { name: 'ask_user', args: {} },
    allowedActions: { accept: false, reject: false, edit: false, respond: true, ignore: true, cancel: false },
    prompt: 'Pick one?',
    contextMarkdown: 'same headline and bullets',
  }
  const textAsk = { ...base, answerSchema: { type: 'text' } }
  const singleAsk = { ...base, answerSchema: { type: 'single', options: [{ value: 'a', label: 'A' }] } }
  assert.notEqual(
    await envelopePayloadHash(textAsk),
    await envelopePayloadHash(singleAsk),
    'a text ask and a single ask with identical prompt/markdown must not share a payloadHash',
  )
  const optionA = { ...base, answerSchema: { type: 'single', options: [{ value: 'a', label: 'A' }] } }
  const optionB = { ...base, answerSchema: { type: 'single', options: [{ value: 'b', label: 'B' }] } }
  assert.notEqual(
    await envelopePayloadHash(optionA),
    await envelopePayloadHash(optionB),
    'same type, different options: different payloadHash',
  )
  const loose = { ...base, answerSchema: { type: 'number', bounds: { min: 0 } } }
  const tight = { ...base, answerSchema: { type: 'number', bounds: { min: 0, max: 10 } } }
  assert.notEqual(
    await envelopePayloadHash(loose),
    await envelopePayloadHash(tight),
    'same type, different bounds: different payloadHash',
  )
  assert.notEqual(
    await envelopePayloadHash(textAsk),
    await envelopePayloadHash({ ...textAsk, prompt: 'Pick one!!' }),
    'prompt is hashed too',
  )
  assert.equal(
    await envelopePayloadHash(optionA),
    await envelopePayloadHash({ ...base, answerSchema: { type: 'single', options: [{ value: 'a', label: 'A' }] } }),
    'an identical ask still hashes equal (create-once replay of the SAME request stays intact)',
  )
})

test('create-once is backward-compatible: envelopes without prompt/answerSchema hash exactly as before', async () => {
  // Legacy asks (fields absent vs undefined) must not retro-split stored
  // create-once keys — JCS drops undefined, so the new optional envelope
  // fields change nothing for pre-widgets envelopes.
  const legacy = {
    action: { name: 'ask_user', args: {} },
    allowedActions: { accept: false, reject: false, edit: false, respond: true, ignore: true, cancel: false },
    contextMarkdown: 'plain question',
  }
  assert.equal(
    await envelopePayloadHash(legacy),
    await envelopePayloadHash({ ...legacy, prompt: undefined, answerSchema: undefined }),
  )
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

test('payloadHash: answerSchema is in the hash (two asks differing only in type/options/bounds never replay)', async () => {
  // hitl/v0 create-once guard: a spent idempotencyKey must not silently replay
  // a DIFFERENT question. The stored answerSchema participates in the hash.
  const base = populatedIngestedEnvelope()
  const differentType = populatedIngestedEnvelope({
    answerSchema: { ...(base.answerSchema as Record<string, unknown>), type: 'multi' },
  })
  const differentOptions = populatedIngestedEnvelope({
    answerSchema: {
      ...(base.answerSchema as Record<string, unknown>),
      options: [{ value: 'a', label: 'A' }, { value: 'c', label: 'C' }],
    },
  })
  const differentBounds = populatedIngestedEnvelope({
    answerSchema: {
      ...(base.answerSchema as Record<string, unknown>),
      bounds: { minItems: 2 },
    },
  })
  const differentPrompt = populatedIngestedEnvelope({ prompt: 'Which hall?' })
  const hash = await envelopePayloadHash(base)
  assert.equal(hash, await jcsHash(JSON.parse(JSON.stringify(base))))
  for (const other of [differentType, differentOptions, differentBounds, differentPrompt]) {
    assert.notEqual(hash, await envelopePayloadHash(other), 'differing ask must produce a different payloadHash (409 idempotency_conflict)')
  }
})
