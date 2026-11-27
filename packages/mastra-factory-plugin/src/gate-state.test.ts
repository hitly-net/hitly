import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeGateAsDecidedElsewhere,
  createMemoryGateStateStore,
  decidedElsewhereReason,
  detectFactoryResolution,
  gateStateKey,
  type GateRecord,
} from './gate-state.ts'

function record(overrides: Partial<GateRecord> = {}): GateRecord {
  return {
    key: 's1:t1:plan',
    sessionId: 's1',
    toolCallId: 't1',
    gate: 'plan',
    status: 'open',
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

test('gateStateKey includes the gate so two gates on one call stay distinct', () => {
  assert.equal(gateStateKey('s1', 't1', 'plan'), 's1:t1:plan')
  assert.notEqual(gateStateKey('s1', 't1', 'plan'), gateStateKey('s1', 't1', 'ask_user'))
  assert.equal(gateStateKey('s1', undefined, 'review'), 's1:none:review')
})

test('memory store round-trips and upserts by key', async () => {
  const store = createMemoryGateStateStore()
  assert.equal(await store.load('s1:t1:plan'), null)

  await store.save(record({ approvalId: 'apr_1' }))
  assert.equal((await store.load('s1:t1:plan'))?.approvalId, 'apr_1')

  await store.save(record({ status: 'factory_resolved', factoryDecision: 'approved' }))
  const loaded = await store.load('s1:t1:plan')
  assert.equal(loaded?.status, 'factory_resolved')
  assert.equal(loaded?.factoryDecision, 'approved')
  assert.equal(await store.load('s1:t2:plan'), null)
})

test('memory store evicts the least recently used past its cap', async () => {
  const store = createMemoryGateStateStore(2)
  await store.save(record({ key: 'a', sessionId: 'a' }))
  await store.save(record({ key: 'b', sessionId: 'b' }))
  await store.load('a') // 'a' is now the more recently used of the two
  await store.save(record({ key: 'c', sessionId: 'c' }))

  assert.equal(await store.load('b'), null)
  assert.notEqual(await store.load('a'), null)
  assert.notEqual(await store.load('c'), null)
})

test('detectFactoryResolution reads the resumed submit_plan output', () => {
  assert.equal(
    detectFactoryResolution('plan', { submittedPlan: { action: 'approved', path: 'p.md' } }),
    'approved',
  )
  assert.equal(detectFactoryResolution('plan', { submittedPlan: { action: 'rejected' } }), 'rejected')
  // The suspend pass carries neither submittedPlan nor an action.
  assert.equal(detectFactoryResolution('plan', { content: 'Plan submitted for approval.' }), null)
  assert.equal(detectFactoryResolution('plan', { submittedPlan: { action: 'edited' } }), null)
  assert.equal(detectFactoryResolution('plan', { submittedPlan: 'not-an-object' }), null)
  assert.equal(detectFactoryResolution('plan', undefined), null)
})

test('detectFactoryResolution reads the resumed ask_user output', () => {
  assert.equal(detectFactoryResolution('ask_user', { content: 'User answered: dark mode' }), 'answered')
  // A HITLy-served ask_user parks the call; its content is the parked marker,
  // and anything else must not read as a Factory answer.
  assert.equal(detectFactoryResolution('ask_user', { content: 'Waiting for HITLy' }), null)
  assert.equal(detectFactoryResolution('ask_user', { content: 'user answered: lowercase' }), null)
  assert.equal(detectFactoryResolution('ask_user', { answer: 'dark mode' }), null)
})

test('detectFactoryResolution has no signal for review, which never suspends', () => {
  assert.equal(detectFactoryResolution('review', { submittedPlan: { action: 'approved' } }), null)
  assert.equal(detectFactoryResolution('review', { content: 'User answered: yes' }), null)
})

test('decidedElsewhereReason names the decision and the surface', () => {
  const reason = decidedElsewhereReason('approved', 'ui')
  assert.match(reason, /Decided in Mastra Factory: approved/)
  assert.match(reason, /channel: ui/)
  assert.match(reason, /decided elsewhere/)
})

// ---------------------------------------------------------------------------
// closeGateAsDecidedElsewhere — the one place a Factory-decided gate is closed
// in HITLy, shared by the observer and the reconciler.
// ---------------------------------------------------------------------------

function openRecord(overrides: Partial<GateRecord> = {}): GateRecord {
  return {
    key: gateStateKey('sess-1', 'tc-1', 'plan'),
    sessionId: 'sess-1',
    toolCallId: 'tc-1',
    gate: 'plan',
    orgId: 'org_1',
    approvalId: 'apv_1',
    status: 'factory_resolved',
    factoryDecision: 'approved',
    factoryChannel: 'ui',
    factoryResolvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function closeDeps(options: {
  cancel?: (id: string, reason?: string) => Promise<void>
  authority?: { status: string; decision: string | null }
  annotate?: (id: string, note: string) => Promise<{ recorded: boolean }>
  maxCancelAttempts?: number
} = {}) {
  const saved: GateRecord[] = []
  const cancels: Array<{ id: string; reason?: string }> = []
  const notes: Array<{ id: string; note: string }> = []
  return {
    saved,
    cancels,
    notes,
    deps: {
      cancelApproval: async (id: string, reason?: string) => {
        cancels.push({ id, reason })
        if (options.cancel) return options.cancel(id, reason)
      },
      getApproval: options.authority
        ? async () => options.authority!
        : undefined,
      annotateApproval: options.annotate
        ?? (async (id: string, note: string) => {
          notes.push({ id, note })
          return { recorded: true }
        }),
      save: async (record: GateRecord) => void saved.push(record),
      maxCancelAttempts: options.maxCancelAttempts,
    },
  }
}

test('closeGateAsDecidedElsewhere cancels once and stamps the gate closed', async () => {
  const h = closeDeps()
  const outcome = await closeGateAsDecidedElsewhere(openRecord(), h.deps)
  assert.equal(outcome, 'cancelled')
  assert.equal(h.cancels.length, 1)
  assert.match(String(h.cancels[0]!.reason), /Decided in Mastra Factory: approved \(channel: ui\)/)
  assert.ok(h.saved.at(-1)!.cancelledAt)
})

test('an already-closed gate is not cancelled again', async () => {
  const h = closeDeps()
  assert.equal(await closeGateAsDecidedElsewhere(openRecord({ cancelledAt: 'earlier' }), h.deps), 'cancelled')
  assert.equal(h.cancels.length, 0)
})

test('a gate with no mirrored HITLy item closes without calling anything', async () => {
  const h = closeDeps()
  assert.equal(await closeGateAsDecidedElsewhere(openRecord({ approvalId: undefined }), h.deps), 'closed')
  assert.equal(h.cancels.length, 0)
})

test('409 with a HITLy decision recorded is a conflict: annotated, never applied', async () => {
  const h = closeDeps({
    cancel: async () => {
      throw Object.assign(new Error('not awaiting a decision'), { status: 409 })
    },
    authority: { status: 'decided', decision: 'reject' },
  })
  assert.equal(await closeGateAsDecidedElsewhere(openRecord(), h.deps), 'conflict')
  const final = h.saved.at(-1)!
  assert.equal(final.status, 'conflict')
  assert.equal(final.hitlyDecision, 'reject')
  assert.equal(final.conflict!.factoryDecision, 'approved')
  assert.equal(h.notes.length, 1)
  assert.match(h.notes[0]!.note, /The HITLy decision was not applied/)
})

test('409 on an expired or withdrawn item is a clean close, not a conflict', async () => {
  for (const status of ['expired', 'cancelled']) {
    const h = closeDeps({
      cancel: async () => {
        throw Object.assign(new Error('not awaiting a decision'), { status: 409 })
      },
      authority: { status, decision: null },
    })
    assert.equal(await closeGateAsDecidedElsewhere(openRecord(), h.deps), 'closed', status)
    assert.ok(h.saved.at(-1)!.cancelledAt)
    assert.equal(h.notes.length, 0)
  }
})

test('a 409 whose authority cannot be read closes the gate rather than crying conflict', async () => {
  const h = closeDeps({
    cancel: async () => {
      throw Object.assign(new Error('not awaiting a decision'), { status: 409 })
    },
  })
  h.deps.getApproval = async () => {
    throw new Error('HITLy unreachable')
  }
  assert.equal(await closeGateAsDecidedElsewhere(openRecord(), h.deps), 'closed')
})

test('a transient cancel failure counts the attempt and asks for a retry', async () => {
  const h = closeDeps({
    cancel: async () => {
      throw new Error('ECONNRESET')
    },
  })
  assert.equal(await closeGateAsDecidedElsewhere(openRecord(), h.deps), 'retry')
  assert.equal(h.saved.at(-1)!.cancelAttempts, 1)
  assert.equal(h.saved.at(-1)!.cancelledAt, undefined)
})

test('the cancel is not retried forever: past the budget the gate is given up on', async () => {
  const h = closeDeps({
    cancel: async () => {
      throw new Error('ECONNRESET')
    },
    maxCancelAttempts: 2,
  })
  const stuck = openRecord({ cancelAttempts: 2 })
  assert.equal(await closeGateAsDecidedElsewhere(stuck, h.deps), 'gave-up')
  assert.equal(h.cancels.length, 0, 'the budget is checked before spending another call')
})
