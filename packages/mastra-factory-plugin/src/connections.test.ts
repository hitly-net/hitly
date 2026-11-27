import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HitlyConnectionRegistry,
  directoryTargetKeyFor,
  parseEnvFallback,
  settingsUserIdFor,
  type ConnectionDirectory,
  type ConnectionSettingsStore,
  type FactoryProjectLister,
  type FactoryProjectSummary,
  type HitlyFactoryConnection,
} from './connections.ts'
import type { HitlyClientLike } from './gates.ts'
import type { PluginRuntimeConfig } from './types.ts'

// ---------------------------------------------------------------------------
// Fakes mirroring IntegrationStorageHandle semantics (settings encrypted,
// subscriptions plain)
// ---------------------------------------------------------------------------

class FakeSettings implements ConnectionSettingsStore {
  rows = new Map<string, HitlyFactoryConnection>()
  private key(orgId: string, userId: string) {
    return `${orgId}\u0000${userId}`
  }
  async get(orgId: string, userId: string) {
    return this.rows.get(this.key(orgId, userId)) ?? null
  }
  async save(orgId: string, userId: string, config: HitlyFactoryConnection) {
    this.rows.set(this.key(orgId, userId), structuredClone(config))
  }
}

class FakeDirectory implements ConnectionDirectory {
  rows: Array<{ id: string; orgId: string; targetKey: string; data: unknown }> = []
  private seq = 0
  async create(row: { orgId: string; targetKey: string; data: unknown }) {
    const record = { id: `sub_${++this.seq}`, ...structuredClone(row) }
    this.rows.push(record)
    return record
  }
  async listByTarget(targetKey: string) {
    return this.rows.filter((r) => r.targetKey === targetKey).map(({ id, orgId }) => ({ id, orgId }))
  }
  async delete(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id)
  }
  async deleteWhere(filter: { orgId: string; targetKey?: string }) {
    this.rows = this.rows.filter(
      (r) => !(r.orgId === filter.orgId && (filter.targetKey === undefined || r.targetKey === filter.targetKey)),
    )
  }
}

class FakeProjects implements FactoryProjectLister {
  constructor(public list: FactoryProjectSummary[] = []) {}
  async listAll() {
    return this.list
  }
}

function envConfig(overrides: Partial<PluginRuntimeConfig> = {}): PluginRuntimeConfig {
  return {
    hitlyBaseUrl: 'https://hitly.example.com',
    hitlyApiKey: 'hk_env',
    projectId: 'prj_env',
    publicBaseUrl: 'https://factory.example.com',
    webhookSigningSecrets: ['whsec_env'],
    gates: { plan: true, review: true, ask_user: true },
    mergeAfterAccept: false,
    pollIntervalMs: 30000,
    ...overrides,
  }
}

function makeRegistry(opts: {
  settings?: FakeSettings
  directory?: FakeDirectory
  projects?: FakeProjects
  envConfig?: PluginRuntimeConfig | null
  envFallback?: string
  clientFactory?: (config: { hitlyBaseUrl: string; hitlyApiKey: string; projectId: string }) => HitlyClientLike
} = {}) {
  const registry = new HitlyConnectionRegistry({
    settings: opts.settings ?? new FakeSettings(),
    directory: opts.directory ?? new FakeDirectory(),
    projects: opts.projects ?? new FakeProjects(),
    envConfig: opts.envConfig === undefined ? envConfig() : opts.envConfig,
    envFallback: parseEnvFallback(opts.envFallback),
    clientFactory: opts.clientFactory,
  })
  return registry
}

const saveInput = {
  hitlyBaseUrl: 'https://hitly.internal/',
  hitlyApiKey: 'hk_saved',
  projectId: 'prj_saved',
  webhookSigningSecret: 'whsec_saved',
}

// ---------------------------------------------------------------------------

test('settings user id and directory target key are namespaced per factory', () => {
  assert.equal(settingsUserIdFor('abc123'), 'factory:abc123')
  assert.equal(directoryTargetKeyFor('abc123'), 'hitly:factory:abc123')
})

test('parseEnvFallback handles all, lists, and unset', () => {
  assert.deepEqual(parseEnvFallback(undefined), { mode: 'none' })
  assert.deepEqual(parseEnvFallback('  '), { mode: 'none' })
  assert.deepEqual(parseEnvFallback('ALL'), { mode: 'all' })
  const list = parseEnvFallback('a, b,,c ')
  assert.equal(list.mode, 'list')
  assert.deepEqual([...(list.mode === 'list' ? list.factoryProjectIds : [])], ['a', 'b', 'c'])
})

test('resolve returns null when neither saved connection nor env fallback exists', async () => {
  const registry = makeRegistry()
  assert.equal(await registry.resolve('org_1', 'fpid_1'), null)
})

test('saved connection wins over env fallback', async () => {
  const registry = makeRegistry({ envFallback: 'all' })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  const conn = await registry.resolve('org_1', 'fpid_1')
  assert.ok(conn)
  assert.equal(conn.source, 'saved')
  assert.equal(conn.config.projectId, 'prj_saved')
  assert.equal(conn.config.hitlyBaseUrl, 'https://hitly.internal')
  assert.deepEqual(conn.config.webhookSigningSecrets, ['whsec_saved'])
  // publicBaseUrl is deployment-level, taken from env config
  assert.equal(conn.config.publicBaseUrl, 'https://factory.example.com')
})

test('env fallback list covers only listed factories; all covers every factory', async () => {
  const listRegistry = makeRegistry({ envFallback: 'fpid_1, fpid_2' })
  assert.ok(await listRegistry.resolve('org_1', 'fpid_1'))
  assert.equal(await listRegistry.resolve('org_1', 'fpid_3'), null)
  const saved = await listRegistry.resolve('org_1', 'fpid_1')
  assert.equal(saved?.source, 'env')
  assert.equal(saved?.config.projectId, 'prj_env')

  const allRegistry = makeRegistry({ envFallback: 'all' })
  assert.ok(await allRegistry.resolve('org_9', 'anything'))
})

test('env fallback inactive when envConfig is null even if list names the factory', async () => {
  const registry = makeRegistry({ envConfig: null, envFallback: 'fpid_1' })
  assert.equal(await registry.resolve('org_1', 'fpid_1'), null)
})

test('save persists encrypted settings row and a directory row containing no secrets', async () => {
  const settings = new FakeSettings()
  const directory = new FakeDirectory()
  const registry = makeRegistry({ settings, directory })
  const conn = await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  assert.equal(conn.connected, true)
  assert.equal(conn.gates.plan, true)
  assert.equal(conn.gates.ask_user, true)

  const stored = settings.rows.get('org_1\u0000factory:fpid_1')
  assert.ok(stored)
  assert.equal(stored.hitlyApiKey, 'hk_saved')
  assert.deepEqual(stored.webhookSigningSecrets, ['whsec_saved'])

  assert.equal(directory.rows.length, 1)
  const dirJson = JSON.stringify(directory.rows[0])
  assert.ok(!dirJson.includes('hk_saved'), 'directory row must not contain the api key')
  assert.ok(!dirJson.includes('whsec_saved'), 'directory row must not contain the signing secret')

  // Re-save replaces the directory row instead of stacking duplicates.
  await registry.save('org_1', 'user_1', 'fpid_1', { ...saveInput, projectId: 'prj_saved_2' })
  assert.equal(directory.rows.length, 1)
  const after = await registry.resolve('org_1', 'fpid_1')
  assert.equal(after?.config.projectId, 'prj_saved_2')
})

test('save rejects invalid inputs', async () => {
  const registry = makeRegistry()
  await assert.rejects(() => registry.save('org_1', 'u', 'f', { ...saveInput, hitlyBaseUrl: 'hitly.internal' }), /http\(s\)/)
  await assert.rejects(() => registry.save('org_1', 'u', 'f', { ...saveInput, hitlyApiKey: '  ' }), /hitlyApiKey/)
  await assert.rejects(() => registry.save('org_1', 'u', 'f', { ...saveInput, projectId: '' }), /projectId/)
  await assert.rejects(() => registry.save('org_1', 'u', 'f', { ...saveInput, webhookSigningSecret: ' , ' }), /webhookSigningSecret/)
})

test('save tolerates comma-separated webhook signing secrets for rotation', async () => {
  const registry = makeRegistry()
  const conn = await registry.save('org_1', 'user_1', 'fpid_1', {
    ...saveInput,
    webhookSigningSecret: 'whsec_old, whsec_new',
  })
  assert.deepEqual(conn.webhookSigningSecrets, ['whsec_old', 'whsec_new'])
})

test('disconnect tombstones the settings row, removes the directory row, and stops resolution', async () => {
  const settings = new FakeSettings()
  const directory = new FakeDirectory()
  const registry = makeRegistry({ settings, directory })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  await registry.disconnect('org_1', 'fpid_1')

  assert.equal(await registry.resolve('org_1', 'fpid_1'), null)
  assert.equal(await registry.resolveByFactoryProjectId('fpid_1'), null)
  assert.equal(directory.rows.length, 0)
  const stored = settings.rows.get('org_1\u0000factory:fpid_1')
  assert.ok(stored)
  assert.equal(stored.connected, false)
})

test('disconnect falls back to env when fallback covers the factory', async () => {
  const registry = makeRegistry({ envFallback: 'all' })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  await registry.disconnect('org_1', 'fpid_1')
  const conn = await registry.resolve('org_1', 'fpid_1')
  assert.equal(conn?.source, 'env')
})

test('resolveByFactoryProjectId finds saved connections via the directory row', async () => {
  const registry = makeRegistry()
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  const conn = await registry.resolveByFactoryProjectId('fpid_1')
  assert.ok(conn)
  assert.equal(conn.source, 'saved')
  assert.equal(conn.orgId, 'org_1')
  assert.equal(await registry.resolveByFactoryProjectId('fpid_missing'), null)
})

test('re-save whose stale-row cleanup fails leaves the connection resolvable', async () => {
  // Guards the create-then-delete ordering: if the process dies (or the
  // write fails) between creating the new directory row and deleting the
  // stale one, a duplicate remains — which is harmless — whereas deleting
  // first would leave NO row and make resume callbacks unresolvable.
  class FlakyDirectory extends FakeDirectory {
    failNextDelete = false
    override async delete(id: string) {
      if (this.failNextDelete) throw new Error('storage unavailable')
      return super.delete(id)
    }
  }
  const directory = new FlakyDirectory()
  const registry = makeRegistry({ directory })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  directory.failNextDelete = true
  await assert.rejects(() => registry.save('org_1', 'user_1', 'fpid_1', { ...saveInput, projectId: 'prj_rotated' }))
  const conn = await registry.resolveByFactoryProjectId('fpid_1')
  assert.ok(conn, 'directory row must survive a failed stale-row cleanup')
  assert.equal(conn.source, 'saved')
  assert.equal(conn.config.projectId, 'prj_rotated')
})

test('resolveByFactoryProjectId falls back to env for covered factories', async () => {
  const projects = new FakeProjects([{ id: 'fpid_2', orgId: 'org_2', name: 'Beta' }])
  const registry = makeRegistry({ projects, envFallback: 'fpid_2' })
  const conn = await registry.resolveByFactoryProjectId('fpid_2')
  assert.ok(conn)
  assert.equal(conn.source, 'env')
  assert.equal(conn.orgId, 'org_2')
  assert.equal(conn.factoryName, 'Beta')
})

test('listAll enumerates saved connections across orgs plus env-fallback projects', async () => {
  const projects = new FakeProjects([
    { id: 'fpid_1', orgId: 'org_1', name: 'Alpha' },
    { id: 'fpid_2', orgId: 'org_2', name: 'Beta' },
    { id: 'fpid_3', orgId: 'org_2', name: 'Gamma' },
  ])
  const registry = makeRegistry({ projects, envFallback: 'fpid_2' })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)

  const all = await registry.listAll()
  const byId = new Map(all.map((c) => [c.factoryProjectId, c]))
  assert.equal(byId.get('fpid_1')?.source, 'saved')
  assert.equal(byId.get('fpid_1')?.factoryName, 'Alpha')
  assert.equal(byId.get('fpid_2')?.source, 'env')
  assert.equal(byId.has('fpid_3'), false)
})

test('listAll omits disconnected factories without env fallback', async () => {
  const projects = new FakeProjects([{ id: 'fpid_1', orgId: 'org_1' }])
  const registry = makeRegistry({ projects })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  await registry.disconnect('org_1', 'fpid_1')
  assert.deepEqual(await registry.listAll(), [])
})

test('touchCallback and recordError patch status without touching credentials', async () => {
  const settings = new FakeSettings()
  const registry = makeRegistry({ settings })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)

  await registry.touchCallback('org_1', 'fpid_1')
  let stored = settings.rows.get('org_1\u0000factory:fpid_1')
  assert.ok(stored?.lastCallbackAt)
  assert.equal(stored?.lastError, null)

  await registry.recordError('org_1', 'fpid_1', 'boom')
  stored = settings.rows.get('org_1\u0000factory:fpid_1')
  assert.equal(stored?.lastError, 'boom')
  assert.equal(stored?.hitlyApiKey, 'hk_saved')

  // Status writes on absent/disconnected rows are no-ops, not crashes.
  await registry.touchCallback('org_x', 'fpid_x')
  await registry.recordError('org_x', 'fpid_x', 'ignored')
})

test('updateRemoteState updates gates and mergeAfterAccept', async () => {
  const settings = new FakeSettings()
  const registry = makeRegistry({ settings })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  await registry.updateRemoteState('org_1', 'fpid_1', { gates: { plan: false, review: true, ask_user: true }, mergeAfterAccept: true })
  const conn = await registry.resolve('org_1', 'fpid_1')
  assert.equal(conn?.config.gates.plan, false)
  assert.equal(conn?.config.mergeAfterAccept, true)
})

test('clientFor caches per factory and rebuilds when credentials rotate', async () => {
  const builds: Array<{ hitlyBaseUrl: string; hitlyApiKey: string; projectId: string }> = []
  const registry = makeRegistry({
    clientFactory: (config) => {
      builds.push(config)
      return {} as HitlyClientLike
    },
  })
  await registry.save('org_1', 'user_1', 'fpid_1', saveInput)
  const first = await registry.resolve('org_1', 'fpid_1')
  assert.ok(first)
  const clientA = registry.clientFor(first)
  const clientB = registry.clientFor(first)
  assert.equal(clientA, clientB)
  assert.equal(builds.length, 1)

  await registry.save('org_1', 'user_1', 'fpid_1', { ...saveInput, hitlyApiKey: 'hk_rotated' })
  const second = await registry.resolve('org_1', 'fpid_1')
  assert.ok(second)
  const clientC = registry.clientFor(second)
  assert.notEqual(clientC, clientA)
  assert.equal(builds.length, 2)
  assert.equal(builds[1].hitlyApiKey, 'hk_rotated')
})

test('clientFor builds env-fallback clients from env credentials', async () => {
  const builds: Array<{ hitlyBaseUrl: string; hitlyApiKey: string; projectId: string }> = []
  const registry = makeRegistry({
    envFallback: 'all',
    clientFactory: (config) => {
      builds.push(config)
      return {} as HitlyClientLike
    },
  })
  const conn = await registry.resolve('org_1', 'fpid_1')
  assert.ok(conn)
  registry.clientFor(conn)
  assert.deepEqual(builds[0], {
    hitlyBaseUrl: 'https://hitly.example.com',
    hitlyApiKey: 'hk_env',
    projectId: 'prj_env',
  })
})
