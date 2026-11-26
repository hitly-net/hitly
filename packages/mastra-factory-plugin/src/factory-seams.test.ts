import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSubscriptionGateStateStore, type HostContextRef } from './factory-seams.ts'
import { gateStateKey, type GateRecord } from './gate-state.ts'

/**
 * The durable half of the gate store: what survives a restart. The memory
 * layer, the observer state machine, and the cancel path are covered in
 * gate-state.test.ts and index.test.ts.
 */

interface Row {
  id: string
  orgId: string
  targetKey: string
  sessionId: string | null
  status: string
  data: unknown
  updatedAt: Date
}

function fakeStorage() {
  const rows: Row[] = []
  let seq = 0
  const handle = {
    async create(input: { orgId: string; targetKey: string; sessionId?: string | null; status?: string; data: unknown }) {
      const row: Row = {
        id: `sub_${++seq}`,
        orgId: input.orgId,
        targetKey: input.targetKey,
        sessionId: input.sessionId ?? null,
        status: input.status ?? 'active',
        data: input.data,
        updatedAt: new Date(),
      }
      rows.push(row)
      return row
    },
    async listByTarget(targetKey: string) {
      return rows.filter((row) => row.targetKey === targetKey)
    },
    async delete(id: string) {
      const at = rows.findIndex((row) => row.id === id)
      if (at < 0) return false
      rows.splice(at, 1)
      return true
    },
  }
  return { rows, storage: { generic: { subscriptions: handle } } }
}

function record(overrides: Partial<GateRecord> = {}): GateRecord {
  const sessionId = overrides.sessionId ?? 'sess-1'
  const toolCallId = overrides.toolCallId ?? 'tc-1'
  const gate = overrides.gate ?? 'plan'
  return {
    key: gateStateKey({ sessionId, toolCallId, gate }),
    sessionId,
    toolCallId,
    gate,
    orgId: 'org_1',
    approvalId: 'apv_1',
    status: 'open',
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

test('a saved gate is readable from storage by a fresh store (restart)', async () => {
  const { storage, rows } = fakeStorage()
  const ref: HostContextRef = { current: { storage } as never }
  const first = createSubscriptionGateStateStore(ref)
  await first.save(record({ status: 'factory_resolved', factoryDecision: 'approved' }))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'factory_resolved', 'the state machine is queryable on the row itself')

  // A new process: nothing in memory, everything in the row.
  const second = createSubscriptionGateStateStore(ref)
  const loaded = await second.load(record().key)
  assert.equal(loaded?.status, 'factory_resolved')
  assert.equal(loaded?.factoryDecision, 'approved')
})

test('saves replace the stored row instead of accumulating history', async () => {
  const { storage, rows } = fakeStorage()
  const ref: HostContextRef = { current: { storage } as never }
  const store = createSubscriptionGateStateStore(ref)
  const first = record()
  await store.save(first)
  await store.save({ ...first, status: 'hitly_applied', hitlyDecision: 'accept' })

  assert.equal(rows.length, 1, 'one row per gate, not one per transition')
  assert.equal((rows[0]!.data as GateRecord).status, 'hitly_applied')
  assert.equal((await store.load(first.key))?.hitlyDecision, 'accept')
})

test('without a bound host context the store is still usable in memory', async () => {
  const store = createSubscriptionGateStateStore({ current: undefined })
  const item = record()
  await store.save(item)
  assert.equal((await store.load(item.key))?.status, 'open', 'no storage, no throw')
})

test('a storage failure degrades to memory and is logged, never thrown', async () => {
  const logged: Array<{ level: string; message: string }> = []
  const ref: HostContextRef = {
    current: {
      storage: {
        generic: {
          subscriptions: {
            async create() {
              throw new Error('connection reset')
            },
            async listByTarget() {
              return []
            },
            async delete() {
              return false
            },
          },
        },
      },
    } as never,
  }
  const store = createSubscriptionGateStateStore(ref, (level, message) => logged.push({ level, message }))
  const item = record()
  await store.save(item)
  assert.equal((await store.load(item.key))?.status, 'open')
  assert.ok(logged.some((entry) => entry.level === 'warn' && entry.message.includes('durable write failed')))
})

test('a record with no org is kept in memory only', async () => {
  const { storage, rows } = fakeStorage()
  const ref: HostContextRef = { current: { storage } as never }
  const store = createSubscriptionGateStateStore(ref)
  const item = { ...record(), orgId: undefined }
  await store.save(item)
  assert.equal(rows.length, 0)
  assert.equal((await store.load(item.key))?.status, 'open')
})

test('a foreign or corrupt row is not read as this gate', async () => {
  const { storage, rows } = fakeStorage()
  const ref: HostContextRef = { current: { storage } as never }
  const store = createSubscriptionGateStateStore(ref)
  const item = record()
  rows.push({
    id: 'sub_junk',
    orgId: 'org_1',
    targetKey: `hitly-gate:${item.key}`,
    sessionId: 'sess-1',
    status: 'open',
    data: { key: 'some:other:gate', status: 'conflict' },
    updatedAt: new Date(),
  })
  assert.equal(await store.load(item.key), null)
})
