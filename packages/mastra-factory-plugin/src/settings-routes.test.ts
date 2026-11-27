import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSettingsRoutes, SETTINGS_BASE_PATH, type SettingsRouteAuth } from './settings-routes.ts'
import {
  clearConnectionCards,
  registerConnectionCard,
  type ConnectionCardResult,
} from './connection-cards.ts'
import { HITLY_CARD_ID, registerHitlyConnectionCard } from './hitly-connection-card.ts'
import {
  HitlyConnectionRegistry,
  type ConnectionDirectory,
  type ConnectionSettingsStore,
  type FactoryProjectLister,
  type FactoryProjectSummary,
  type HitlyFactoryConnection,
} from './connections.ts'
import type { HitlyClientLike } from './gates.ts'
import type { PluginRuntimeConfig } from './types.ts'

const SECRET_API_KEY = 'htl_live_supersecret_1234'
const SECRET_SIGNING = 'whsec_verysecret_5678'

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

function envConfig(): PluginRuntimeConfig {
  return {
    hitlyBaseUrl: 'https://hitly.example.com',
    hitlyApiKey: 'hk_env',
    projectId: 'prj_env',
    publicBaseUrl: 'https://factory.example.com',
    webhookSigningSecrets: ['whsec_env'],
    gates: { plan: true, review: true, ask_user: true },
    mergeAfterAccept: false,
    pollIntervalMs: 30000,
  }
}

interface SetupOptions {
  admin?: boolean
  authEnabled?: boolean
  withAuth?: boolean
  envFallback?: string
  projects?: FactoryProjectSummary[]
  connectionTester?: (input: { hitlyBaseUrl: string; hitlyApiKey: string; projectId: string; webhookSigningSecret: string }) => Promise<{ ok: boolean; error?: string }>
  fetchImpl?: typeof fetch
}

function makeSetup(opts: SetupOptions = {}) {
  const settings = new FakeSettings()
  const directory = new FakeDirectory()
  const projects: FactoryProjectSummary[] = opts.projects ?? [{ id: 'fproj_1', orgId: 'org_1', name: 'Primary' }]
  const lister: FactoryProjectLister = { listAll: async () => projects }
  const clients = new Map<string, HitlyClientLike>()
  const registry = new HitlyConnectionRegistry({
    settings,
    directory,
    projects: lister,
    envConfig: envConfig(),
    envFallback: opts.envFallback ? { mode: 'list' as const, factoryProjectIds: new Set(opts.envFallback.split(',')) } : { mode: 'none' as const },
    clientFactory: (config) => {
      const key = `${config.hitlyBaseUrl}|${config.hitlyApiKey}|${config.projectId}`
      let client = clients.get(key)
      if (!client) {
        client = { createApproval: async () => ({ id: 'apv_x', status: 'pending' }) }
        clients.set(key, client)
      }
      return client
    },
  })
  const auth: SettingsRouteAuth | undefined = opts.withAuth === false
    ? undefined
    : {
        enabled: () => opts.authEnabled ?? true,
        ensureUser: async (c: unknown) => {
          if ((c as { anon?: boolean }).anon) throw new Error('no user')
        },
        tenant: () => ({ orgId: 'org_1', userId: 'user_1' }),
        isOrganizationAdmin: async (_c: unknown, orgId: string) => (opts.admin ?? true) && orgId === 'org_1',
      }
  const routes = buildSettingsRoutes({
    registry,
    auth,
    projects: lister,
    connectionTester: opts.connectionTester,
    fetchImpl: opts.fetchImpl,
  })
  const route = (method: 'GET' | 'POST', path: string) => {
    const found = routes.find((r) => r.method === method && r.path === path)
    if (!found) throw new Error(`no route ${method} ${path}`)
    return found
  }
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; anon?: boolean } = {},
  ) => {
    const request = new Request(`https://factory.example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
    })
    const context = { req: { raw: request }, anon: options.anon === true }
    const response = await route(method, new URL(path, 'https://factory.example.com').pathname).handler(context)
    return { status: response.status, body: await response.text(), response }
  }
  const connect = (overrides: Record<string, unknown> = {}) =>
    call('POST', `${SETTINGS_BASE_PATH}/connect`, {
      body: {
        factoryProjectId: 'fproj_1',
        hitlyBaseUrl: 'https://hitly.example.com',
        hitlyApiKey: SECRET_API_KEY,
        projectId: 'prj_1',
        webhookSigningSecret: SECRET_SIGNING,
        ...overrides,
      },
    })
  return { registry, settings, directory, routes, call, connect, projects }
}

// ─── auth gating ─────────────────────────────────────────────────────────────

for (const [label, path, method] of [
  ['page', SETTINGS_BASE_PATH, 'GET'],
  ['api', `${SETTINGS_BASE_PATH}/api`, 'GET'],
  ['cards', `${SETTINGS_BASE_PATH}/cards/api`, 'GET'],
  ['connect', `${SETTINGS_BASE_PATH}/connect`, 'POST'],
  ['disconnect', `${SETTINGS_BASE_PATH}/disconnect`, 'POST'],
  ['test', `${SETTINGS_BASE_PATH}/test`, 'POST'],
] as const) {
  test(`settings ${label}: anonymous gets 401`, async () => {
    const t = makeSetup()
    const res = await t.call(method, path, { anon: true, body: {} })
    assert.equal(res.status, 401)
  })
}

test('settings: non-admin gets 403 on every route', async () => {
  const t = makeSetup({ admin: false })
  for (const [method, path] of [
    ['GET', SETTINGS_BASE_PATH],
    ['GET', `${SETTINGS_BASE_PATH}/api`],
    ['GET', `${SETTINGS_BASE_PATH}/cards/api`],
    ['POST', `${SETTINGS_BASE_PATH}/connect`],
    ['POST', `${SETTINGS_BASE_PATH}/disconnect`],
    ['POST', `${SETTINGS_BASE_PATH}/test`],
  ] as const) {
    const res = await t.call(method, path, { body: { factoryProjectId: 'fproj_1' } })
    assert.equal(res.status, 403, `${method} ${path}`)
  }
})

test('settings: fail closed with 503 when the host context carries no auth', async () => {
  const t = makeSetup({ withAuth: false })
  const res = await t.call('GET', `${SETTINGS_BASE_PATH}/api`)
  assert.equal(res.status, 503)
})

// ─── connect → list → disconnect round trip + secret hygiene ────────────────

test('settings: connect, list, disconnect round-trip; no secret ever leaves the server', async () => {
  const t = makeSetup()
  const saved = await t.connect()
  assert.equal(saved.status, 200)
  assert.ok(t.settings.rows.size === 1)

  const api = await t.call('GET', `${SETTINGS_BASE_PATH}/api`)
  assert.equal(api.status, 200)
  const parsed = JSON.parse(api.body) as { connections: Array<Record<string, unknown>> }
  assert.equal(parsed.connections.length, 1)
  assert.equal(parsed.connections[0].hitlyProjectId, 'prj_1')
  assert.equal(parsed.connections[0].source, 'saved')

  const page = await t.call('GET', SETTINGS_BASE_PATH)
  assert.equal(page.status, 200)

  // Acceptance criterion 6: assert on FULL bodies, not just known fields.
  for (const body of [saved.body, api.body, page.body]) {
    assert.ok(!body.includes(SECRET_API_KEY), 'api key must never appear in a response')
    assert.ok(!body.includes(SECRET_SIGNING), 'signing secret must never appear in a response')
  }
  // Masked display only.
  assert.ok(api.body.includes(`••••${SECRET_API_KEY.slice(-4)}`))

  const dropped = await t.call('POST', `${SETTINGS_BASE_PATH}/disconnect`, { body: { factoryProjectId: 'fproj_1' } })
  assert.equal(dropped.status, 200)
  const after = await t.call('GET', `${SETTINGS_BASE_PATH}/api`)
  assert.deepEqual(JSON.parse(after.body).connections, [])
})

test('settings: connect validation rejects missing fields with 400', async () => {
  const t = makeSetup()
  for (const field of ['hitlyBaseUrl', 'hitlyApiKey', 'projectId', 'webhookSigningSecret', 'factoryProjectId']) {
    const res = await t.connect({ [field]: '' })
    assert.equal(res.status, 400, `${field} required`)
    assert.ok(res.body.includes(field))
  }
})

// ─── XSS: every interpolated value is escaped ────────────────────────────────

test('settings: factory names are HTML-escaped (no script injection)', async () => {
  const t = makeSetup({ projects: [{ id: 'fproj_1', orgId: 'org_1', name: '<script>alert(1)</script>' }] })
  await t.connect()
  const page = await t.call('GET', SETTINGS_BASE_PATH)
  assert.ok(!page.body.includes('<script>alert(1)</script>'), 'raw name must not reach the DOM')
  assert.ok(page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'name is escaped')
})

test('settings: connection errors are HTML-escaped', async () => {
  const t = makeSetup()
  await t.connect()
  await t.registry.recordError('org_1', 'fproj_1', '<img src=x onerror=alert(1)>')
  const page = await t.call('GET', SETTINGS_BASE_PATH)
  assert.ok(!page.body.includes('<img src=x'))
  assert.ok(page.body.includes('&lt;img src=x'))
})

// ─── test button: read-only probe ────────────────────────────────────────────

test('settings: test button only GETs the HITLy integration config endpoint', async () => {
  const seen: Array<{ method: string; url: string }> = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const request = input instanceof Request ? input : new Request(input)
    seen.push({ method: request.method, url: request.url })
    return Response.json({ gates: { plan: true, review: true, ask_user: true }, mergeAfterAccept: false })
  }) as unknown as typeof fetch
  const t = makeSetup({ fetchImpl })
  await t.connect()
  const res = await t.call('POST', `${SETTINGS_BASE_PATH}/test`, { body: { factoryProjectId: 'fproj_1' } })
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'GET')
  assert.ok(seen[0].url.endsWith('/api/v1/projects/prj_1/integrations/mastra-factory'))
  assert.ok(!res.body.includes(SECRET_API_KEY))
})

test('settings: test button reports auth failure without throwing', async () => {
  const fetchImpl = (async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 })) as unknown as typeof fetch
  const t = makeSetup({ fetchImpl })
  await t.connect()
  const res = await t.call('POST', `${SETTINGS_BASE_PATH}/test`, { body: { factoryProjectId: 'fproj_1' } })
  assert.equal(res.status, 200)
  const parsed = JSON.parse(res.body) as { ok: boolean; error?: string }
  assert.equal(parsed.ok, false)
  assert.ok(parsed.error)
})

test('settings: test button with unsaved form credentials probes those, not the saved ones', async () => {
  const inputs: string[] = []
  const t = makeSetup({
    connectionTester: async (input) => {
      inputs.push(`${input.hitlyBaseUrl}|${input.hitlyApiKey}|${input.projectId}`)
      return { ok: true }
    },
  })
  await t.connect()
  const res = await t.call('POST', `${SETTINGS_BASE_PATH}/test`, {
    body: { hitlyBaseUrl: 'https://staging.hitly.example', hitlyApiKey: 'hk_draft', projectId: 'prj_draft' },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(inputs, ['https://staging.hitly.example|hk_draft|prj_draft'])
})

test('settings: test for an unconnected factory is 404', async () => {
  const t = makeSetup({ connectionTester: async () => ({ ok: true }) })
  const res = await t.call('POST', `${SETTINGS_BASE_PATH}/test`, { body: { factoryProjectId: 'fproj_1' } })
  assert.equal(res.status, 404)
})

// ─── env fallback visibility ─────────────────────────────────────────────────

test('settings: env-fallback factories are listed and badged distinctly', async () => {
  const t = makeSetup({ envFallback: 'fproj_1' })
  const api = await t.call('GET', `${SETTINGS_BASE_PATH}/api`)
  const parsed = JSON.parse(api.body) as { connections: Array<{ source: string; factoryProjectId: string }> }
  assert.equal(parsed.connections.length, 1)
  assert.equal(parsed.connections[0].source, 'env')
  const page = await t.call('GET', SETTINGS_BASE_PATH)
  assert.ok(page.body.includes('env fallback'))
  // A saved connection replaces the badge for that factory.
  await t.connect()
  const after = await t.call('GET', `${SETTINGS_BASE_PATH}/api`)
  const rows = JSON.parse(after.body) as { connections: Array<{ source: string }> }
  assert.equal(rows.connections[0].source, 'saved')
})

// ─── Connections card API (hitly-net/hitly#218) ──────────────────────────────

interface Card {
  id: string
  name: string
  description: string
  icon: string
  settingsPath: string | null
  status: string
  label: string
  detail: string | null
}

async function cardsOf(t: { call: (m: 'GET', p: string, o?: { anon?: boolean }) => Promise<{ body: string }> }) {
  const res = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/api`)
  return JSON.parse(res.body) as { cards: Card[] }
}

test('cards: hitly card reports not-connected with no saved connection', async () => {
  const t = makeSetup()
  registerHitlyConnectionCard({ getRegistry: () => t.registry })
  try {
    const { cards } = await cardsOf(t)
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.id, HITLY_CARD_ID)
    assert.equal(cards[0]!.status, 'not-connected')
    assert.equal(cards[0]!.label, 'Not connected')
    assert.equal(cards[0]!.settingsPath, SETTINGS_BASE_PATH)
  } finally {
    clearConnectionCards()
  }
})

test('cards: a saved connection shows as connected, without leaking the api key or signing secret', async () => {
  const t = makeSetup()
  registerHitlyConnectionCard({ getRegistry: () => t.registry })
  try {
    await t.connect()
    const res = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/api`)
    const { cards } = JSON.parse(res.body) as { cards: Card[] }
    assert.equal(cards[0]!.status, 'connected')
    assert.equal(cards[0]!.label, 'Connected')
    assert.match(cards[0]!.detail ?? '', /1 factory connected/, 'aggregate counts the connected factories')

    const perFactory = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/api?factoryProjectId=fproj_1`)
    const single = JSON.parse(perFactory.body) as { cards: Card[] }
    assert.equal(single.cards[0]!.status, 'connected')
    assert.ok(single.cards[0]!.detail?.includes('https://hitly.example.com'), 'per-factory detail names the HITLy project')
    assert.ok(single.cards[0]!.detail?.includes('prj_1'))
    assert.ok(!res.body.includes(SECRET_API_KEY), 'the card payload never carries the api key')
    assert.ok(!res.body.includes(SECRET_SIGNING), 'nor the webhook signing secret')
  } finally {
    clearConnectionCards()
  }
})

test('cards: an env-fallback factory is badged as such, per factory and in aggregate', async () => {
  const t = makeSetup({ envFallback: 'fproj_1' })
  registerHitlyConnectionCard({ getRegistry: () => t.registry })
  try {
    const { cards } = await cardsOf(t)
    assert.equal(cards[0]!.status, 'env-fallback')
    assert.match(cards[0]!.detail ?? '', /env fallback/)

    const perFactory = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/api?factoryProjectId=fproj_1`)
    const single = JSON.parse(perFactory.body) as { cards: Card[] }
    assert.equal(single.cards[0]!.status, 'env-fallback')

    const unknown = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/api?factoryProjectId=fproj_missing`)
    const missing = JSON.parse(unknown.body) as { cards: Card[] }
    assert.equal(missing.cards[0]!.status, 'not-connected')
  } finally {
    clearConnectionCards()
  }
})

test('cards: a card that throws or stalls is dropped, the rest of the screen survives', async () => {
  const t = makeSetup()
  registerHitlyConnectionCard({ getRegistry: () => t.registry })
  registerConnectionCard({
    id: 'stalls',
    name: 'Stalls',
    description: 'never answers',
    order: 1,
    status: () => new Promise<ConnectionCardResult>(() => undefined),
  })
  try {
    const res = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/api`)
    assert.equal(res.status, 200)
    const { cards } = JSON.parse(res.body) as { cards: Card[] }
    assert.deepEqual(cards.map((card) => card.id), [HITLY_CARD_ID], 'the stalled card is skipped, not shown broken')
  } finally {
    clearConnectionCards()
  }
})

test('cards: no registry means no card, so the screen offers no dead link', async () => {
  registerHitlyConnectionCard({ getRegistry: () => null })
  const t = makeSetup()
  // The card is registered but cannot resolve; the route still answers 200 with an empty list.
  const res = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/api`)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { cards: [] })
  clearConnectionCards()
})

// ─── injected bootstrap ──────────────────────────────────────────────────────

test('boot.js: public, javascript, and pointed at the gated cards API', async () => {
  const t = makeSetup()
  const res = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/boot.js`, { anon: true })
  assert.equal(res.status, 200, 'the static bootstrap carries no secrets, so it needs no session')
  assert.match(res.response.headers.get('content-type') ?? '', /text\/javascript/)
  assert.ok(res.body.includes(`"${SETTINGS_BASE_PATH}"`), 'the bootstrap knows where its cards API lives')
  assert.ok(res.body.includes('/cards/api'), 'cards come from the admin-gated API')
  assert.equal(res.response.headers.get('cache-control'), 'no-store', 'a reverted patch must not linger in the browser cache')
})

test('boot.js: HITLY_CONNECTION_CARDS_ANCHOR prepends an operator-supplied anchor', async () => {
  const t = makeSetup()
  process.env.HITLY_CONNECTION_CARDS_ANCHOR = 'section[data-page="connections"]'
  try {
    const res = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/boot.js`, { anon: true })
    assert.ok(
      res.body.includes('"section[data-page=\\"connections\\"]"'),
      'a drifted Factory build can be handled without a redeploy of this package',
    )
  } finally {
    delete process.env.HITLY_CONNECTION_CARDS_ANCHOR
  }
})

test('boot.js: 404 while the Factory UI patch is switched off', async () => {
  const t = makeSetup()
  process.env.HITLY_FACTORY_UI_PATCH = '0'
  try {
    const res = await t.call('GET', `${SETTINGS_BASE_PATH}/cards/boot.js`)
    assert.equal(res.status, 404)
  } finally {
    delete process.env.HITLY_FACTORY_UI_PATCH
  }
})
