import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HitlyReconciler, type OpenApproval } from './worker.ts'
import { METADATA_KEYS } from './gates.ts'
import type { ApprovalSnapshot } from './types.ts'
import { createMemoryGateStateStore, gateStateKey, type GateRecord, type GateStateStore } from './gate-state.ts'

function open(gate: 'plan' | 'review' | 'ask_user', id = 'apv_1'): OpenApproval {
  return {
    approvalId: id,
    gate,
    metadata: {
      [METADATA_KEYS.gate]: gate,
      [METADATA_KEYS.sessionId]: 'sess-1',
      [METADATA_KEYS.toolCallId]: 'tc-1',
      [METADATA_KEYS.threadId]: 'thread-1',
      [METADATA_KEYS.orgId]: 'org_1',
      [METADATA_KEYS.userId]: 'user_1',
      ...(gate === 'review' ? { [METADATA_KEYS.prUrl]: 'https://github.com/hitly-net/hitly/pull/201', [METADATA_KEYS.headSha]: 'abc123' } : {}),
    },
  }
}

interface Harness {
  open: OpenApproval[]
  snapshots: ApprovalSnapshot[]
  closed: string[]
  acks: string[]
  cancels: Array<{ id: string; reason?: string }>
  notes: Array<{ id: string; note: string }>
  calls: number
  reconciler: HitlyReconciler
}

function harness(options: {
  approvals: OpenApproval[]
  state(id: string): Promise<{ id: string; status: string; decision: string | null; metadata: Record<string, unknown> }>
  refresh?: () => Promise<void>
  apply?(snapshot: ApprovalSnapshot): Promise<{ applied: boolean; reason?: string }>
  ackFails?: boolean
  gateStore?: GateStateStore
  cancel?(id: string, reason?: string): Promise<void>
  annotate?(id: string, note: string): Promise<{ recorded: boolean }>
}): Harness {
  const h = {} as Harness
  h.open = [...options.approvals]
  h.snapshots = []
  h.closed = []
  h.acks = []
  h.cancels = []
  h.notes = []
  h.calls = 0
  h.reconciler = new HitlyReconciler({
    listOpen: () => h.open,
    closeOpen: (id) => {
      h.closed.push(id)
      h.open = h.open.filter((a) => a.approvalId !== id)
    },
    getApproval: async (id) => {
      h.calls += 1
      return options.state(id)
    },
    refreshConfig: options.refresh,
    apply:
      options.apply ??
      (async (snapshot) => {
        h.snapshots.push(snapshot)
        return { applied: true }
      }),
    ackResume: async (id) => {
      if (options.ackFails) throw new Error('503 ack unavailable')
      h.acks.push(id)
    },
    gateStore: options.gateStore,
    cancelApproval: options.cancel
      ? async (id, reason) => {
          h.cancels.push({ id, reason })
          await options.cancel!(id, reason)
        }
      : undefined,
    annotateApproval: options.annotate
      ? async (id, note) => {
          h.notes.push({ id, note })
          return options.annotate!(id, note)
        }
      : undefined,
  })
  return h
}

function planRecord(overrides: Partial<GateRecord> = {}): GateRecord {
  const now = new Date(0).toISOString()
  return {
    key: gateStateKey('sess-1', 'tc-1', 'plan'),
    sessionId: 'sess-1',
    toolCallId: 'tc-1',
    gate: 'plan',
    orgId: 'org_1',
    approvalId: 'apv_1',
    status: 'open',
    updatedAt: now,
    ...overrides,
  }
}

test('tick applies a HITLy decision the callback never delivered, exactly once', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'decided', decision: 'accept', metadata: {} }),
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 1)
  assert.equal(h.snapshots.length, 1)
  assert.equal(h.snapshots[0]!.decision, 'accept')
  assert.equal(h.snapshots[0]!.sessionId, 'sess-1')
  assert.deepEqual(h.closed, ['apv_1'])
})

test('pending approvals are never applied and stay open for later ticks', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'pending', decision: null, metadata: {} }),
  })
  await h.reconciler.tick()
  await h.reconciler.tick()
  assert.equal(h.snapshots.length, 0)
  assert.deepEqual(h.closed, [])
  assert.equal(h.calls, 2)
})

test('failed_resume with a recorded decision converges — HITLy has no auto-retry', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }),
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 1)
  assert.equal(h.snapshots.length, 1)
  assert.equal(h.snapshots[0]!.status, 'failed_resume')
  assert.equal(h.snapshots[0]!.decision, 'accept')
  assert.deepEqual(h.closed, ['apv_1'])
})

test('failed_resume without a decision stays open until one exists', async () => {
  let decided = false
  const h = harness({
    approvals: [open('plan')],
    state: async () =>
      decided
        ? { id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }
        : { id: 'apv_1', status: 'failed_resume', decision: null, metadata: {} },
  })
  await h.reconciler.tick()
  assert.equal(h.snapshots.length, 0)
  assert.deepEqual(h.closed, [])
  assert.deepEqual(h.acks, [])
  decided = true
  const second = await h.reconciler.tick()
  assert.equal(second.applied, 1)
  assert.deepEqual(h.closed, ['apv_1'])
})

test('a converged failed_resume decision is acked so the row leaves the feed', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }),
  })
  await h.reconciler.tick()
  assert.deepEqual(h.acks, ['apv_1'])
  // A second tick has nothing left to do — the close removed it locally and
  // the ack removed it server-side, so no further replay is possible.
  const second = await h.reconciler.tick()
  assert.equal(second.applied, 0)
  assert.deepEqual(h.acks, ['apv_1'])
})

test('rows that never needed delivery are not acked', async () => {
  // `decided` means the callback already succeeded — no receipt to send.
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'decided', decision: 'accept', metadata: {} }),
  })
  await h.reconciler.tick()
  assert.deepEqual(h.acks, [])
})

test('replay against an already-answered parked call counts as delivered and settles', async () => {
  // A failed_resume whose callback actually landed (or that a previous
  // process converged) makes answerParkedCall throw "Nothing is waiting on
  // that tool call any more". That is delivery proven, not an error —
  // otherwise a plan gate would error on every tick and every restart.
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }),
    apply: async () => {
      throw new Error('Nothing is waiting on that tool call any more: the run that asked has ended or it was already answered.')
    },
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 1)
  assert.equal(result.errors, 0)
  assert.deepEqual(h.closed, ['apv_1'])
  assert.deepEqual(h.acks, ['apv_1'])
})

test('an unrelated apply failure on a failed_resume row is not swallowed and is not acked', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }),
    apply: async () => {
      throw new Error('storage backend exploded')
    },
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 0)
  assert.equal(result.errors, 1)
  assert.deepEqual(h.closed, [])
  assert.deepEqual(h.acks, [])
})

test('a lost ack never fails the tick — the apply is already delivered', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }),
    ackFails: true,
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 1)
  assert.equal(result.errors, 0)
  assert.deepEqual(h.closed, ['apv_1'])
})

test('expiry reaches the apply matrix as closure — the matrix decides, never the poller', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'expired', decision: null, metadata: {} }),
  })
  await h.reconciler.tick()
  assert.equal(h.snapshots.length, 1)
  assert.equal(h.snapshots[0]!.status, 'expired')
  assert.equal(h.snapshots[0]!.decision, null)
  assert.deepEqual(h.closed, ['apv_1'])
})

test('config refresh is attempted each tick; failure keeps current gates (fail-closed)', async () => {
  let refreshes = 0
  const h = harness({
    approvals: [open('ask_user')],
    state: async () => ({ id: 'apv_1', status: 'pending', decision: null, metadata: {} }),
    refresh: async () => {
      refreshes += 1
      if (refreshes === 1) throw new Error('hitly unreachable')
    },
  })
  const first = await h.reconciler.tick()
  assert.equal(first.configRefreshed, false)
  const second = await h.reconciler.tick()
  assert.equal(second.configRefreshed, true)
})

test('transient approval read failure keeps the approval open for retry', async () => {
  let failed = false
  const h = harness({
    approvals: [open('review')],
    state: async () => {
      if (!failed) {
        failed = true
        throw Object.assign(new Error('503'), { status: 503 })
      }
      return { id: 'apv_1', status: 'decided', decision: 'reject', metadata: {} }
    },
  })
  const first = await h.reconciler.tick()
  assert.equal(first.errors, 1)
  assert.equal(h.snapshots.length, 0)
  const second = await h.reconciler.tick()
  assert.equal(second.applied, 1)
  assert.equal(h.snapshots[0]!.decision, 'reject')
})

test('authority metadata wins over stored metadata when they disagree', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({
      id: 'apv_1',
      status: 'decided',
      decision: 'reject',
      metadata: { [METADATA_KEYS.sessionId]: 'sess-9', [METADATA_KEYS.toolCallId]: 'tc-9' },
    }),
  })
  await h.reconciler.tick()
  assert.equal(h.snapshots[0]!.sessionId, 'sess-9')
  assert.equal(h.snapshots[0]!.toolCallId, 'tc-9')
})

test('unknown gate closes the approval without applying anything', async () => {
  const h = harness({
    approvals: [{ approvalId: 'apv_bad', gate: 'deploy' as never, metadata: { [METADATA_KEYS.gate]: 'deploy' } }],
    state: async () => ({ id: 'apv_bad', status: 'decided', decision: 'accept', metadata: {} }),
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 0)
  assert.equal(h.snapshots.length, 0)
  assert.deepEqual(h.closed, ['apv_bad'])
})

// ---------------------------------------------------------------------------
// Gate memory: a gate the Factory surface answered is never converged from
// HITLy state, and a decision that arrives on such a gate is reported as a
// conflict instead of being counted as delivered.
// ---------------------------------------------------------------------------

test('a Factory-decided gate retries the requester cancel and never reaches the apply matrix', async () => {
  // The observer recorded the Factory answer but its cancel never reached
  // HITLy (process died in between). HITLy still shows the item pending —
  // converging that state as "delivered" was the original silent-success bug.
  const gateStore = createMemoryGateStateStore()
  await gateStore.save(planRecord({ status: 'factory_resolved', factoryDecision: 'approved', factoryChannel: 'ui' }))
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'pending', decision: null, metadata: {} }),
    gateStore,
    cancel: async () => {},
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 0)
  assert.equal(h.snapshots.length, 0)
  assert.equal(h.cancels.length, 1)
  assert.equal(h.cancels[0]!.id, 'apv_1')
  assert.match(h.cancels[0]!.reason!, /Decided in Mastra Factory: approved/)
  assert.deepEqual(h.closed, ['apv_1'])
  const record = await gateStore.load(gateStateKey('sess-1', 'tc-1', 'plan'))
  assert.equal(record!.status, 'factory_resolved')
  assert.ok(record!.cancelledAt)
})

test('a Factory-decided gate already cancelled on HITLy is dropped without another cancel', async () => {
  const gateStore = createMemoryGateStateStore()
  await gateStore.save(planRecord({ status: 'factory_resolved', factoryDecision: 'rejected', cancelledAt: new Date(1).toISOString() }))
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'pending', decision: null, metadata: {} }),
    gateStore,
    cancel: async () => {
      throw new Error('must not be called')
    },
  })
  await h.reconciler.tick()
  assert.equal(h.cancels.length, 0)
  assert.equal(h.snapshots.length, 0)
  assert.deepEqual(h.closed, ['apv_1'])
})

test('a transient cancel failure leaves the gate open for the next tick', async () => {
  const gateStore = createMemoryGateStateStore()
  await gateStore.save(planRecord({ status: 'factory_resolved', factoryDecision: 'approved' }))
  let down = true
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'pending', decision: null, metadata: {} }),
    gateStore,
    cancel: async () => {
      if (down) throw Object.assign(new Error('503 unavailable'), { status: 503 })
    },
  })
  const first = await h.reconciler.tick()
  assert.deepEqual(h.closed, [])
  assert.equal(first.errors, 0, 'a retryable close is not a reconcile error')
  down = false
  const second = await h.reconciler.tick()
  assert.equal(second.checked, 1)
  assert.deepEqual(h.closed, ['apv_1'])
  const record = await gateStore.load(gateStateKey('sess-1', 'tc-1', 'plan'))
  assert.equal(record!.cancelAttempts, 2, 'both the failed attempt and the successful one are counted')
  assert.ok(record!.cancelledAt)
})

test('a cancel rejected because HITLy decided first is a conflict, not a delivery', async () => {
  // Mid-air: the reviewer clicked in HITLy while the Factory answer was being
  // observed. The 409 plus the authority read is what proves both sides acted.
  const gateStore = createMemoryGateStateStore()
  await gateStore.save(planRecord({ status: 'factory_resolved', factoryDecision: 'approved', factoryChannel: 'ui' }))
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'decided', decision: 'reject', metadata: {} }),
    gateStore,
    cancel: async () => {
      throw Object.assign(new Error('409 Approval is not awaiting a decision'), { status: 409 })
    },
    annotate: async () => ({ recorded: true }),
  })
  const result = await h.reconciler.tick()
  assert.equal(result.conflicts, 1)
  assert.equal(result.applied, 0)
  assert.equal(h.snapshots.length, 0, 'a HITLy decision on a Factory-decided gate is never applied')
  assert.deepEqual(h.closed, ['apv_1'])
  assert.equal(h.notes.length, 1)
  const record = await gateStore.load(gateStateKey('sess-1', 'tc-1', 'plan'))
  assert.equal(record!.status, 'conflict')
  assert.equal(record!.hitlyDecision, 'reject')
  assert.equal(record!.conflict?.factoryDecision, 'approved')
})

test('a cancel rejected because the item is already closed elsewhere is a clean close', async () => {
  const gateStore = createMemoryGateStateStore()
  await gateStore.save(planRecord({ status: 'factory_resolved', factoryDecision: 'approved' }))
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'expired', decision: null, metadata: {} }),
    gateStore,
    cancel: async () => {
      throw Object.assign(new Error('409 expired'), { status: 409 })
    },
  })
  const result = await h.reconciler.tick()
  assert.equal(result.conflicts, 0)
  assert.deepEqual(h.closed, ['apv_1'])
  assert.equal(h.notes.length, 0)
})

test('a Factory-decided gate with no cancel path is dropped, not retried forever', async () => {
  const gateStore = createMemoryGateStateStore()
  await gateStore.save(planRecord({ status: 'factory_resolved', factoryDecision: 'approved' }))
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'pending', decision: null, metadata: {} }),
    gateStore,
  })
  const first = await h.reconciler.tick()
  const second = await h.reconciler.tick()
  assert.equal(first.checked, 1)
  assert.equal(second.checked, 0)
  assert.equal(h.snapshots.length, 0)
  assert.deepEqual(h.closed, ['apv_1'])
})

test('a replay onto an already-answered call with an OPEN gate record is a conflict', async () => {
  // Nothing was parked, no Factory decision was ever observed, and HITLy still
  // handed us a decision: the silent-success path from the issue. It must be
  // reported, not counted as delivered.
  const gateStore = createMemoryGateStateStore()
  await gateStore.save(planRecord())
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }),
    gateStore,
    apply: async () => {
      throw new Error('Nothing is waiting on that tool call any more: it was already answered.')
    },
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 0)
  assert.equal(result.conflicts, 1)
  assert.equal(result.errors, 0, 'a conflict is terminal, not a retryable error')
  assert.deepEqual(h.closed, ['apv_1'])
  assert.deepEqual(h.acks, ['apv_1'], 'HITLy still needs the receipt so the row leaves the feed')
  const record = await gateStore.load(gateStateKey('sess-1', 'tc-1', 'plan'))
  assert.equal(record!.status, 'conflict')
  assert.equal(record!.hitlyDecision, 'accept')
  assert.match(record!.conflict!.detail, /was not applied/)
})

test('an apply that reports a conflict is counted as a conflict, not an error or a delivery', async () => {
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'decided', decision: 'accept', metadata: {} }),
    apply: async () => ({ applied: false, conflict: true }),
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 0)
  assert.equal(result.errors, 0)
  assert.equal(result.conflicts, 1)
  assert.deepEqual(h.closed, ['apv_1'])
})

test('without gate memory the replay path keeps its old already-delivered semantics', async () => {
  // Rows opened before gate memory existed have no record to attribute the
  // answer to. Counting them as delivered preserves the previous behaviour and
  // avoids an infinite retry loop on legacy rows.
  const h = harness({
    approvals: [open('plan')],
    state: async () => ({ id: 'apv_1', status: 'failed_resume', decision: 'accept', metadata: {} }),
    apply: async () => {
      throw new Error('Nothing is waiting on that tool call any more: it was already answered.')
    },
  })
  const result = await h.reconciler.tick()
  assert.equal(result.applied, 1)
  assert.equal(result.conflicts, 0)
  assert.deepEqual(h.closed, ['apv_1'])
})
