import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDecision, type ApplyDeps } from './apply.ts'
import type { ApprovalSnapshot, Gate } from './types.ts'

interface Call {
  kind: 'parked' | 'signal' | 'merge' | 'merge-ready'
  args: Record<string, unknown>
}

function fakeDeps(options: { gates?: Partial<Record<Gate, boolean>>; mergeAfterAccept?: boolean } = {}): ApplyDeps & { calls: Call[]; mergeAttempts: number } {
  const calls: Call[] = []
  const state = { mergeAttempts: 0 }
  return {
    calls,
    get mergeAttempts() {
      return state.mergeAttempts
    },
    gates: { plan: true, review: true, ask_user: true, ...options.gates },
    mergeAfterAccept: options.mergeAfterAccept ?? false,
    answerParked: async (args) => {
      calls.push({ kind: 'parked', args })
    },
    signalSession: async (args) => {
      calls.push({ kind: 'signal', args })
    },
    markMergeReady: async (args) => {
      calls.push({ kind: 'merge-ready', args })
    },
    attemptMerge: async (args) => {
      state.mergeAttempts += 1
      calls.push({ kind: 'merge', args })
      return { merged: true }
    },
    recordEvent: async () => {},
    alreadyApplied: async () => false,
    markApplied: async () => {},
  }
}

function snapshot(gate: Gate, overrides: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot {
  return {
    id: 'apv_1',
    status: 'decided',
    decision: 'accept',
    gate,
    sessionId: 'sess-1',
    threadId: 'thread-1',
    toolCallId: 'tc-1',
    orgId: 'org_1',
    userId: 'user_1',
    factoryProjectId: 'proj_1',
    metadata: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Plan gate
// ---------------------------------------------------------------------------

test('plan + accept answers the parked submit_plan exactly once, no merge, no signal', async () => {
  const deps = fakeDeps()
  const outcome = await applyDecision(snapshot('plan', { decision: 'accept' }), deps)
  assert.equal(outcome.applied, true)
  assert.deepEqual(deps.calls.map((c) => c.kind), ['parked'])
  assert.equal(deps.calls[0]!.args.decision, 'approve')
})

test('plan + reject declines the parked call with the reviewer reason', async () => {
  const deps = fakeDeps()
  await applyDecision(snapshot('plan', { decision: 'reject', reason: 'scope creep' }), deps)
  assert.deepEqual(deps.calls.map((c) => c.kind), ['parked'])
  assert.equal(deps.calls[0]!.args.decision, 'decline')
  assert.match(String(deps.calls[0]!.args.reason), /scope creep/)
})

test('plan + edit declines the parked call (fail-closed) and signals the edited plan verbatim', async () => {
  const deps = fakeDeps()
  await applyDecision(snapshot('plan', { decision: 'edit', editedArgs: { plan: 'revised steps' }, reason: 'narrow it' }), deps)
  const kinds = deps.calls.map((c) => c.kind)
  assert.deepEqual(kinds, ['parked', 'signal'])
  assert.equal(deps.calls[0]!.args.decision, 'decline') // never auto-approve an edit
  assert.equal(deps.calls[1]!.args.message.includes('revised steps'), true)
})

test('plan expiry declines the parked call — expiry is never approval', async () => {
  for (const status of ['expired', 'cancelled'] as const) {
    const deps = fakeDeps()
    const outcome = await applyDecision(snapshot('plan', { decision: null, status }), deps)
    assert.equal(outcome.applied, true)
    assert.deepEqual(deps.calls.map((c) => c.kind), ['parked'])
    assert.equal(deps.calls[0]!.args.decision, 'decline')
  }
})

// ---------------------------------------------------------------------------
// Review gate — the hard rules
// ---------------------------------------------------------------------------

test('review + accept marks merge-ready; merge runs ONLY when mergeAfterAccept is on', async () => {
  const off = fakeDeps({ mergeAfterAccept: false })
  await applyDecision(snapshot('review', { decision: 'accept', headSha: 'abc123', prUrl: 'https://github.com/hitly-net/hitly/pull/1' }), off)
  assert.deepEqual(off.calls.map((c) => c.kind), ['merge-ready', 'signal'])
  assert.equal(off.mergeAttempts, 0)

  const on = fakeDeps({ mergeAfterAccept: true })
  await applyDecision(snapshot('review', { decision: 'accept', headSha: 'abc123', prUrl: 'https://github.com/hitly-net/hitly/pull/1' }), on)
  assert.equal(on.mergeAttempts, 1)
})

test('review + reject NEVER attempts merge under any config', async () => {
  const deps = fakeDeps({ mergeAfterAccept: true }) // even with merge enabled…
  await applyDecision(snapshot('review', { decision: 'reject', reason: 'tests missing', prUrl: 'https://github.com/hitly-net/hitly/pull/1' }), deps)
  assert.equal(deps.mergeAttempts, 0)
  assert.equal(deps.calls.some((c) => c.kind === 'merge'), false)
  // findings still reach the session
  assert.equal(deps.calls.some((c) => c.kind === 'signal' && String(c.args.message).includes('tests missing')), true)
})

test('review expiry is signal-only: no merge, no parked-call answer', async () => {
  const deps = fakeDeps({ mergeAfterAccept: true })
  const outcome = await applyDecision(snapshot('review', { decision: null, status: 'expired' }), deps)
  assert.equal(outcome.applied, true)
  assert.equal(deps.mergeAttempts, 0)
  assert.deepEqual(deps.calls.map((c) => c.kind), ['signal'])
})

// ---------------------------------------------------------------------------
// ask_user gate
// ---------------------------------------------------------------------------

test('ask_user + respond delivers the typed answer verbatim via session signal', async () => {
  const deps = fakeDeps()
  await applyDecision(snapshot('ask_user', { decision: 'respond', response: 'Use POST /v2/widgets' }), deps)
  assert.deepEqual(deps.calls.map((c) => c.kind), ['signal'])
  assert.equal(deps.calls[0]!.args.message.includes('Use POST /v2/widgets'), true)
  assert.equal(deps.calls.some((c) => c.kind === 'parked'), false) // no typed-answer seam exists in 0.31.0
})

test('ask_user + reject signals the decline; NEVER invents an answer', async () => {
  const deps = fakeDeps()
  await applyDecision(snapshot('ask_user', { decision: 'reject', reason: 'not now' }), deps)
  assert.equal(deps.calls.length, 1)
  assert.equal(deps.calls[0]!.kind, 'signal')
  const message = String(deps.calls[0]!.args.message)
  assert.equal(message.includes('not now'), true)
  // The message must be explicit that no answer was given
  assert.match(message, /declined|no answer/i)
})

test('ask_user empty response is never delivered as a fabricated answer', async () => {
  const deps = fakeDeps()
  const outcome = await applyDecision(snapshot('ask_user', { decision: 'respond', response: '   ' }), deps)
  assert.equal(outcome.applied, false)
  assert.match(outcome.reason ?? '', /empty|missing/i)
  assert.equal(deps.calls.length, 0)
})

test('ask_user expiry signals that no answer arrived — never a default', async () => {
  const deps = fakeDeps()
  await applyDecision(snapshot('ask_user', { decision: null, status: 'expired' }), deps)
  assert.equal(deps.calls.length, 1)
  assert.equal(deps.calls[0]!.kind, 'signal')
  assert.match(String(deps.calls[0]!.args.message), /no answer|expired/i)
})

// ---------------------------------------------------------------------------
// Safety invariants across the matrix
// ---------------------------------------------------------------------------

test('pending status is never applied — only decided/expired/cancelled drive actions', async () => {
  const deps = fakeDeps()
  const outcome = await applyDecision(snapshot('plan', { status: 'pending', decision: 'accept' }), deps)
  assert.equal(outcome.applied, false)
  assert.equal(deps.calls.length, 0)
})

test('failed_resume with a recorded decision converges like decided', async () => {
  const deps = fakeDeps({ mergeAfterAccept: false })
  const outcome = await applyDecision(
    snapshot('review', { status: 'failed_resume', decision: 'accept', headSha: 'abc123', prUrl: 'https://github.com/hitly-net/hitly/pull/1' }),
    deps,
  )
  assert.equal(outcome.applied, true)
  assert.deepEqual(deps.calls.map((c) => c.kind), ['merge-ready', 'signal'])
  assert.equal(deps.mergeAttempts, 0)
})

test('failed_resume without a decision is never applied — no approval to converge to', async () => {
  for (const gate of ['plan', 'review', 'ask_user'] as const) {
    const deps = fakeDeps({ mergeAfterAccept: true })
    const outcome = await applyDecision(snapshot(gate, { status: 'failed_resume', decision: null }), deps)
    assert.equal(outcome.applied, false, gate)
    assert.equal(deps.calls.length, 0, gate)
    assert.equal(deps.mergeAttempts, 0, gate)
  }
})

test('failed_resume reject never merges, even with mergeAfterAccept on', async () => {
  const deps = fakeDeps({ mergeAfterAccept: true })
  const outcome = await applyDecision(
    snapshot('review', { status: 'failed_resume', decision: 'reject', prUrl: 'https://github.com/hitly-net/hitly/pull/1' }),
    deps,
  )
  assert.equal(outcome.applied, true)
  assert.equal(deps.mergeAttempts, 0)
})

test('failed_resume shares the (approvalId, decision) idempotency key with decided', async () => {
  const appliedKeys: string[] = []
  const deps = fakeDeps()
  deps.alreadyApplied = async (key) => appliedKeys.includes(key)
  deps.markApplied = async (key) => {
    appliedKeys.push(key)
  }
  // Callback lands as decided first; a later poll sees the same decision on
  // the same row (or vice versa via Retry-Resume) and must dedupe.
  const first = await applyDecision(snapshot('plan', { decision: 'accept' }), deps)
  const second = await applyDecision(snapshot('plan', { status: 'failed_resume', decision: 'accept' }), deps)
  assert.equal(first.applied, true)
  assert.equal(second.applied, false)
  assert.match(second.reason ?? '', /already/i)
  assert.equal(deps.calls.filter((c) => c.kind === 'parked').length, 1)
})

test('applyDecision is idempotent per (approvalId, decision)', async () => {
  const appliedKeys: string[] = []
  const deps = fakeDeps()
  deps.alreadyApplied = async (key) => appliedKeys.includes(key)
  deps.markApplied = async (key) => {
    appliedKeys.push(key)
  }
  const snap = snapshot('plan', { decision: 'accept' })
  const first = await applyDecision(snap, deps)
  const second = await applyDecision(snap, deps)
  assert.equal(first.applied, true)
  assert.equal(second.applied, false)
  assert.match(second.reason ?? '', /already/i)
  assert.equal(deps.calls.filter((c) => c.kind === 'parked').length, 1)
})

test('ignore decision on any gate is a no-op ack, never a merge', async () => {
  for (const gate of ['plan', 'review', 'ask_user'] as const) {
    const deps = fakeDeps({ mergeAfterAccept: true })
    const outcome = await applyDecision(snapshot(gate, { decision: 'ignore' }), deps)
    assert.equal(outcome.applied, false, gate)
    assert.equal(deps.calls.length, 0, gate)
    assert.equal(deps.mergeAttempts, 0, gate)
  }
})

test('unknown gate rejects the decision rather than guessing behavior', async () => {
  const deps = fakeDeps()
  const outcome = await applyDecision({ ...snapshot('plan'), gate: 'deploy' as Gate }, deps)
  assert.equal(outcome.applied, false)
  assert.match(outcome.reason ?? '', /gate/i)
})

test('missing session identity fails closed with no calls', async () => {
  const deps = fakeDeps()
  const outcome = await applyDecision(snapshot('plan', { decision: 'accept', sessionId: undefined }), deps)
  assert.equal(outcome.applied, false)
  assert.equal(deps.calls.length, 0)
})
