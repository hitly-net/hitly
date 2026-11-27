import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpPlugin, CB_AUTH_TOKEN_KEY } from '@hitly/plugin-http'
import { detectGate, buildApprovalRequest, GATE_METADATA_KEY, RESUME_PATH } from './gates.ts'
import type { GateSession } from './types.ts'

const session: GateSession = {
  sessionId: 'sess-1',
  threadId: 'thread-1',
  orgId: 'org-1',
  userId: 'user-1',
  factoryProjectId: 'proj-f-1',
}

const baseConfig = {
  hitlyBaseUrl: 'https://hitly.example.com',
  hitlyApiKey: 'hk_test_1',
  projectId: 'proj-1',
  publicBaseUrl: 'https://factory.example.com',
  webhookSigningSecrets: ['whsec_a'],
  gates: { plan: true, review: true, ask_user: true },
  mergeAfterAccept: false,
  githubToken: undefined as string | undefined,
  pollIntervalMs: 30000,
}

test('gate tool mapping is exact and closed', () => {
  assert.equal(detectGate('submit_plan', baseConfig.gates), 'plan')
  assert.equal(detectGate('factory_record_review_verdict', baseConfig.gates), 'review')
  assert.equal(detectGate('ask_user', baseConfig.gates), 'ask_user')
  assert.equal(detectGate('execute_command', baseConfig.gates), null)
  assert.equal(detectGate('source_control_merge_change_request', baseConfig.gates), null)
})

test('disabled gates are not detected', () => {
  assert.equal(detectGate('submit_plan', { plan: false, review: true, ask_user: true }), null)
  assert.equal(detectGate('factory_record_review_verdict', { plan: true, review: false, ask_user: true }), null)
  assert.equal(detectGate('ask_user', { plan: true, review: true, ask_user: false }), null)
})

test('plan approval request carries plan body, gate metadata, resumeUrl, plugin', () => {
  const req = buildApprovalRequest({
    gate: 'plan',
    toolCallId: 'tc-1',
    session,
    input: { path: '.artifacts/plans/x.md', content: '# Plan\nDo the thing' },
    output: { status: 'approved_pending' },
    config: baseConfig,
  })
  assert.equal(req.plugin, 'mastra-factory')
  assert.equal(req.metadata?.[GATE_METADATA_KEY], 'plan')
  assert.equal(req.metadata?.['net.hitly/factory/session-id'], 'sess-1')
  assert.match(req.contextMarkdown ?? '', /Do the thing/)
  assert.ok(req.resumeUrl?.endsWith(`${RESUME_PATH}/proj-f-1`), 'resumeUrl must carry the factory segment of the per-factory resume route')
  assert.ok(req.resumeUrl?.startsWith('https://factory.example.com'))
  assert.equal(req.runId, 'factory:sess-1:tc-1')
  assert.equal(req.idempotencyKey, 'hitly-mf:sess-1:tc-1')
})

test('idempotency key is deterministic per session+toolCall and stable across retries', () => {
  const args = {
    gate: 'plan' as const,
    toolCallId: 'tc-9',
    session,
    input: { content: 'p' },
    output: undefined,
    config: baseConfig,
  }
  // cbAuthToken is per-request random; everything else must be reproducible.
  const { cbAuthToken: _a, ...first } = buildApprovalRequest(args)
  const { cbAuthToken: _b, ...second } = buildApprovalRequest(args)
  assert.deepEqual(first, second)
})

test('ask_user approval carries the question and respond-allowed actions only', () => {
  const req = buildApprovalRequest({
    gate: 'ask_user',
    toolCallId: 'tc-2',
    session,
    input: { question: 'Which provider: A or B?' },
    output: undefined,
    config: baseConfig,
  })
  assert.equal(req.question, 'Which provider: A or B?')
  assert.equal(req.allowedActions?.respond, true)
  assert.equal(req.allowedActions?.accept, false)
  assert.equal(req.allowedActions?.edit, false)
})

test('review approval carries verdict context and PR metadata', () => {
  const req = buildApprovalRequest({
    gate: 'review',
    toolCallId: 'tc-3',
    session,
    input: { verdict: 'approve', body: 'Verdict: approve\nLGTM' },
    output: undefined,
    pr: { url: 'https://github.com/hitly-net/hitly/pull/201', headSha: 'abc1234' },
    config: baseConfig,
  })
  assert.equal(req.metadata?.[GATE_METADATA_KEY], 'review')
  assert.equal(req.metadata?.['net.hitly/factory/pr-url'], 'https://github.com/hitly-net/hitly/pull/201')
  assert.equal(req.metadata?.['net.hitly/factory/head-sha'], 'abc1234')
  assert.match(req.contextMarkdown ?? '', /LGTM/)
  assert.equal(req.allowedActions?.accept, true)
  assert.equal(req.allowedActions?.respond, false)
})

test('plan gate allows accept/reject/edit but never respond', () => {
  const req = buildApprovalRequest({
    gate: 'plan',
    toolCallId: 'tc-4',
    session,
    input: { content: 'x' },
    output: undefined,
    config: baseConfig,
  })
  assert.equal(req.allowedActions?.accept, true)
  assert.equal(req.allowedActions?.reject, true)
  assert.equal(req.allowedActions?.edit, true)
  assert.equal(req.allowedActions?.respond, false)
})

test('plan and review requests carry a per-request cbAuthToken and array reasonRequired', () => {
  const make = (gate: 'plan' | 'review') =>
    buildApprovalRequest({
      gate,
      toolCallId: `tc-${gate}`,
      session,
      input: gate === 'plan' ? { content: 'x' } : { verdict: 'approve', body: 'LGTM' },
      output: undefined,
      config: baseConfig,
    })
  const plan = make('plan')
  const review = make('review')
  for (const req of [plan, review]) {
    assert.equal(typeof req.cbAuthToken, 'string')
    assert.ok((req.cbAuthToken ?? '').length >= 32, 'cbAuthToken must be a high-entropy token')
    assert.deepEqual(req.reasonRequired, ['reject'], 'must be an array of answer values, not a boolean')
  }
  assert.notEqual(plan.cbAuthToken, review.cbAuthToken, 'tokens are per-request, not reused')
})

test('plan and review create bodies pass the real plugin-http ingest validator', () => {
  // Regression: reasonRequired was sent as boolean `true`, which the
  // plugin-http validator rejects with 400 on every plan/review create.
  for (const gate of ['plan', 'review'] as const) {
    const request = buildApprovalRequest({
      gate,
      toolCallId: `tc-validator-${gate}`,
      session,
      input: gate === 'plan' ? { content: 'x' } : { verdict: 'approve', body: 'LGTM' },
      output: undefined,
      config: baseConfig,
    })
    const envelope = httpPlugin.ingest(structuredClone(request))
    assert.equal(envelope.origin.runId, `factory:sess-1:tc-validator-${gate}`)
    assert.equal(envelope.origin.resumeHandle?.[CB_AUTH_TOKEN_KEY], request.cbAuthToken, 'HITLy must store the cbAuthToken it will echo as bearer')
  }
})
