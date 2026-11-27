import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSubscriptionGateStateStore, createHitlyIntegration, type HostContextRef } from './factory-seams.ts'
import { gateStateKey, type GateRecord } from './gate-state.ts'
import { parseRuntimeConfig } from './config.ts'
import { HitlyConnectionRegistry } from './connections.ts'
import { SETTINGS_BASE_PATH } from './settings-routes.ts'

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

test('a terminal save that lost its org stays durable via the row it replaces', async () => {
  const logged: Array<{ level: string; message: string }> = []
  const { storage, rows } = fakeStorage()
  const ref: HostContextRef = { current: { storage } as never }
  const store = createSubscriptionGateStateStore(ref, (level, message) => logged.push({ level, message }))
  const item = record()
  await store.save(item)
  // The HITLy snapshot that drives this transition may carry no org of its own.
  await store.save({ ...item, orgId: undefined, status: 'hitly_applied', hitlyDecision: 'accept' })

  assert.equal(rows.length, 1, 'the gate is still durable after the org-less transition')
  assert.equal((rows[0]!.data as GateRecord).status, 'hitly_applied')
  assert.equal(rows[0]!.orgId, 'org_1', 'the replacement row keeps the gate in the same org')
  assert.equal(logged.length, 0, 'an inherited org is not a degradation worth logging')

  // And it survived: a restart still sees the applied gate, so a late replay
  // cannot be mistaken for a fresh decision.
  const restarted = createSubscriptionGateStateStore(ref)
  assert.equal((await restarted.load(item.key))?.status, 'hitly_applied')
})

test('a terminal status that cannot be persisted is warned about, not skipped quietly', async () => {
  const logged: Array<{ level: string; message: string }> = []
  const { storage, rows } = fakeStorage()
  const ref: HostContextRef = { current: { storage } as never }
  const store = createSubscriptionGateStateStore(ref, (level, message) => logged.push({ level, message }))
  const item = { ...record(), orgId: undefined, status: 'conflict' as const }
  await store.save(item)

  assert.equal(rows.length, 0)
  assert.ok(
    logged.some((entry) => entry.level === 'warn' && entry.message.includes('not persisted')),
    'losing a conflict across a restart is worth a warn; an unopened gate is not',
  )
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

// ---------------------------------------------------------------------------
// Registry binding (#218): per-factory connections exist only if the registry
// gets host integration storage, and the shape the host actually offers is
// what decides that.
// ---------------------------------------------------------------------------

const bindingEnv = {
  HITLY_API_URL: 'https://hitly.example.com',
  HITLY_API_KEY: 'hk_test_1',
  HITLY_PROJECT_ID: 'proj-1',
  HITLY_PUBLIC_URL: 'https://factory.example.com',
  HITLY_WEBHOOK_SIGNING_SECRETS: 'whsec_a',
}

const clientStub = { createApproval: async () => ({ id: 'apv_1', status: 'pending' }) }

function hostStores() {
  const settingsRows = new Map<string, unknown>()
  const directory: Array<{ id: string; orgId: string; targetKey: string; data: unknown }> = []
  return {
    settingsRows,
    directory,
    settings: {
      get: async (orgId: string, userId: string) => (settingsRows.get(`${orgId}|${userId}`) ?? null) as never,
      save: async (orgId: string, userId: string, config: unknown) => {
        settingsRows.set(`${orgId}|${userId}`, config)
      },
    },
    subscriptions: {
      create: async (row: { orgId: string; targetKey: string; data: unknown }) => {
        const id = `sub_${directory.length + 1}`
        directory.push({ id, ...row })
        return { id }
      },
      listByTarget: async (targetKey: string) => directory.filter((r) => r.targetKey === targetKey),
      delete: async (id: string) => {
        const i = directory.findIndex((r) => r.id === id)
        if (i >= 0) directory.splice(i, 1)
      },
      deleteWhere: async (where: { orgId: string; targetKey?: string }) => {
        for (let i = directory.length - 1; i >= 0; i--) {
          const row = directory[i]!
          if (row.orgId === where.orgId && (!where.targetKey || row.targetKey === where.targetKey)) directory.splice(i, 1)
        }
      },
    },
    projects: { listAll: async () => [{ id: 'fproj_1', orgId: 'org_1', name: 'Primary' }] },
  }
}

const adminAuth = {
  enabled: () => true,
  ensureUser: async () => undefined,
  tenant: () => ({ orgId: 'org_1', userId: 'user_1' }),
  isOrganizationAdmin: async () => true,
}

function bindingIntegration(options: { registry?: never } = {}) {
  const logs: Array<{ level: string; message: string }> = []
  const integration = createHitlyIntegration({
    config: parseRuntimeConfig(bindingEnv),
    client: clientStub,
    log: (level, message) => logs.push({ level, message }),
    ...options,
  })
  const settingsMounted = (ctx: unknown) => integration.routes(ctx as never).some((r) => r.path === SETTINGS_BASE_PATH)
  return { integration, logs, settingsMounted }
}

/** The IntegrationContext as @mastra/factory 0.30.0 really shapes it. */
function context030(stores: ReturnType<typeof hostStores>) {
  return {
    auth: adminAuth,
    // No forIntegration on this handle: it belongs to the IntegrationStorage
    // domain class, which never reaches an integration.
    storage: { generic: { settings: stores.settings, subscriptions: stores.subscriptions }, projects: stores.projects },
  }
}

test('the registry binds to the 0.30.0 IntegrationContext handle, and the settings page mounts', () => {
  const stores = hostStores()
  const { logs, settingsMounted } = bindingIntegration()
  assert.equal('forIntegration' in (context030(stores).storage.generic as object), false, 'the real handle has no forIntegration')
  assert.ok(settingsMounted(context030(stores)), 'settings routes appear once the registry has host storage')
  assert.ok(logs.some((l) => l.level === 'info' && l.message.includes('per-factory connections enabled')))
  assert.ok(!logs.some((l) => l.level === 'warn'), 'no storage warning when the handle is complete')
})

test('the registry also binds at prepare() through initialize({ storage, projects })', async () => {
  const stores = hostStores()
  const { integration, settingsMounted } = bindingIntegration()
  await integration.initialize!({ storage: { settings: stores.settings, subscriptions: stores.subscriptions }, projects: stores.projects } as never)
  // Routes are collected with a context that carries no storage at all: the
  // binding already happened, so the settings page still mounts.
  assert.ok(settingsMounted({ auth: adminAuth }), 'prepare-time storage is enough to enable the settings page')
})

test('an unusable initialize() does not spend the IntegrationContext chance', async () => {
  const stores = hostStores()
  const { integration, settingsMounted } = bindingIntegration()
  await integration.initialize!({} as never)
  assert.ok(settingsMounted(context030(stores)), 'the routes()-time context still gets to bind the registry')
})

test('a host that does expose forIntegration() still works', () => {
  const stores = hostStores()
  const { settingsMounted } = bindingIntegration()
  const ctx = {
    auth: adminAuth,
    storage: {
      generic: { forIntegration: (id: string) => (id === 'hitly' ? { settings: stores.settings, subscriptions: stores.subscriptions } : undefined) },
      projects: stores.projects,
    },
  }
  assert.ok(settingsMounted(ctx), 'the scoping factory stays supported as a fallback')
})

test('missing host storage disables the settings page and says precisely what is missing', () => {
  const { logs, settingsMounted } = bindingIntegration()
  assert.equal(settingsMounted({ auth: adminAuth, storage: { generic: {}, projects: undefined } }), false, 'fail closed, no throw')
  const warn = logs.find((l) => l.level === 'warn')
  assert.ok(warn, 'the boot log explains why per-factory connections are off')
  assert.match(warn!.message, /settings, subscriptions.*missing/)
  // Asked again (routes() then workers()), the plugin does not repeat the warning.
  settingsMounted({ auth: adminAuth })
  assert.equal(logs.filter((l) => l.level === 'warn').length, 1, 'the same host shape warns once')
})

test('a registry supplied by the host is never replaced by binding', () => {
  const stores = hostStores()
  const supplied = new HitlyConnectionRegistry({
    settings: stores.settings as never,
    directory: stores.subscriptions as never,
    projects: stores.projects as never,
    envConfig: null,
    envFallback: { mode: 'none' },
  })
  const { logs, settingsMounted } = bindingIntegration({ registry: supplied as never })
  assert.ok(settingsMounted(context030(stores)))
  assert.ok(!logs.some((l) => l.message.includes('registry bound')), 'first-wins: the supplied registry stays in place')
})
