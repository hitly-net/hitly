import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HitlyMastraFactoryPlugin } from './index.ts'
import type { HitlyPluginOptions } from './index.ts'
import type { HitlyClientLike } from './gates.ts'
import { RESUME_PATH, METADATA_KEYS } from './gates.ts'
import { HitlyConnectionRegistry, parseEnvFallback } from './connections.ts'
import { signBody, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_EVENT_ID, HEADER_KEY_ID } from '@hitly/plugin-http'
import { parseRuntimeConfig } from './config.ts'
import type { Gate } from './types.ts'

const baseEnv = {
  HITLY_API_URL: 'https://hitly.example.com',
  HITLY_API_KEY: 'hk_test_1',
  HITLY_PROJECT_ID: 'proj-1',
  HITLY_PUBLIC_URL: 'https://factory.example.com',
  HITLY_WEBHOOK_SIGNING_SECRETS: 'whsec_a',
}

type FakeApproval = {
  id: string
  status: string
  decision: string | null
  metadata: Record<string, unknown>
  reason?: string
}

function fakeClient(): HitlyClientLike & {
  created: Array<{ body: unknown; key: string }>
  approvals: Record<string, FakeApproval> | null
  pending: FakeApproval[] | null
  remoteConfig: { gates: Record<Gate, boolean>; mergeAfterAccept: boolean } | null
  acked: string[]
  unreachable: boolean
} {
  const created: Array<{ body: unknown; key: string }> = []
  const state = {
    created,
    approvals: null as Record<string, FakeApproval> | null,
    pending: null as FakeApproval[] | null,
    remoteConfig: null as { gates: Record<Gate, boolean>; mergeAfterAccept: boolean } | null,
    acked: [] as string[],
    unreachable: false,
    createApproval: async (body: Record<string, unknown>, idempotencyKey: string) => {
      if (state.unreachable) throw new Error('hitly unreachable')
      created.push({ body, key: idempotencyKey })
      return { id: `apv_${created.length}`, status: 'pending' }
    },
    getApproval: async (id: string) => {
      if (state.unreachable) throw new Error('hitly unreachable')
      const approval = state.approvals?.[id]
      if (!approval) throw Object.assign(new Error('not found'), { status: 404 })
      return approval
    },
    listPending: async () => {
      if (state.unreachable) throw new Error('hitly unreachable')
      return state.pending ?? []
    },
    getIntegrationConfig: async () => {
      if (state.unreachable) throw new Error('hitly unreachable')
      return state.remoteConfig ?? { gates: { plan: true, review: true, ask_user: true }, mergeAfterAccept: false }
    },
    ackResume: async (id: string) => {
      if (state.unreachable) throw new Error('hitly unreachable')
      state.acked.push(id)
    },
  }
  return state
}

const fakeSeams = {
  resolveSessionTarget: () => ({
    sessionId: 'sess-1',
    threadId: 'thread-1',
    orgId: 'org_1',
    userId: 'user_1',
    factoryProjectId: 'fproj_1',
  }),
}

function toolEvent(toolName: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const requestContext = { get: (_k: string) => undefined }
  return {
    args: {
      toolContext: { toolName, input, context: requestContext, toolCallId: 'tc-1', ...extra },
      requestContext,
    },
  }
}

function makePlugin(options: { env?: Record<string, string | undefined>; gates?: Record<string, boolean> } = {}) {
  const client = fakeClient()
  const config = parseRuntimeConfig(options.env ?? baseEnv)
  const plugin = new HitlyMastraFactoryPlugin({
    config,
    client,
    seams: fakeSeams,
    ...(options.gates ? { gateOverrides: options.gates as never } : {}),
  })
  return { plugin, client }
}

test('integration id is stable and namespaced', () => {
  const { plugin } = makePlugin()
  assert.equal(plugin.id, 'hitly')
})

test('routes(ctx) registers the resume endpoint at the documented path', () => {
  const { plugin } = makePlugin()
  const routes = plugin.routes!({} as never)
  assert.equal(routes.length >= 1, true)
  assert.equal(routes.some((r) => r.path === '/custom/integrations/hitly/resume'), true)
  // `/api` is reserved by @mastra/server (1.85+): mounting there crashes the host.
  assert.equal(routes.some((r) => r.path.startsWith('/api')), false)
})

test('submit_plan tool call opens a plan approval with gate metadata and create-once key', async () => {
  const { plugin, client } = makePlugin()
  const { args } = toolEvent('submit_plan', { plan: 'do the thing' })
  await plugin.postToolObserver!(args as never)
  assert.equal(client.created.length, 1)
  const { body, key } = client.created[0]!
  const payload = body as Record<string, unknown>
  const meta = payload.metadata as Record<string, string>
  assert.equal(payload.plugin, 'mastra-factory')
  assert.equal(meta['net.hitly/gate'], 'plan')
  assert.equal(meta['net.hitly/factory/session-id'], 'sess-1')
  assert.equal(meta['net.hitly/factory/tool-call-id'], 'tc-1')
  assert.equal(typeof payload.resumeUrl, 'string')
  assert.match(String(payload.resumeUrl), /^https:\/\/factory\.example\.com\/custom\/integrations\/hitly\/resume\/fproj_1$/)
  assert.match(key, /sess-1.*tc-1/)
  // Per-request callback bearer: HITLy echoes this back on the resume callback.
  assert.equal(typeof payload.cbAuthToken, 'string')
  assert.ok(String(payload.cbAuthToken).length >= 32)
})

test('same tool call observed twice creates only ONE approval (in-process dedupe + create-once key)', async () => {
  const { plugin, client } = makePlugin()
  const { args } = toolEvent('submit_plan', { plan: 'x' })
  await plugin.postToolObserver!(args as never)
  await plugin.postToolObserver!(args as never)
  assert.equal(client.created.length, 1)
})

test('factory_record_review_verdict opens a review approval carrying the head SHA when known', async () => {
  const { plugin, client } = makePlugin()
  const { args } = toolEvent('factory_record_review_verdict', { verdict: 'approve' }, { output: { headSha: 'abc123', prUrl: 'https://github.com/hitly-net/hitly/pull/1' } })
  await plugin.postToolObserver!(args as never)
  const payload = client.created[0]!.body as { metadata: Record<string, string> }
  assert.equal(payload.metadata['net.hitly/gate'], 'review')
  assert.equal(payload.metadata['net.hitly/factory/head-sha'], 'abc123')
  assert.equal(payload.metadata['net.hitly/factory/pr-url'], 'https://github.com/hitly-net/hitly/pull/1')
})

test('ask_user opens an ask_user approval with the question in the prompt', async () => {
  const { plugin, client } = makePlugin()
  const { args } = toolEvent('ask_user', { question: 'Which API version?', options: [{ label: 'v1' }, { label: 'v2' }] })
  await plugin.postToolObserver!(args as never)
  const payload = client.created[0]!.body as Record<string, unknown>
  const meta = payload.metadata as Record<string, string>
  assert.equal(meta['net.hitly/gate'], 'ask_user')
  assert.match(String(payload.contextMarkdown ?? payload.prompt ?? ''), /Which API version\?/)
})

test('non-gate tools open nothing', async () => {
  const { plugin, client } = makePlugin()
  for (const tool of ['execute_command', 'view', 'write_file', 'web_search']) {
    const { args } = toolEvent(tool)
    await plugin.postToolObserver!(args as never)
  }
  assert.equal(client.created.length, 0)
})

test('failed tool calls (error) open nothing — a crashed gate tool is not a gate', async () => {
  const { plugin, client } = makePlugin()
  const requestContext = { get: () => undefined }
  await plugin.postToolObserver!({
    toolContext: { toolName: 'submit_plan', input: {}, error: new Error('boom'), context: requestContext, toolCallId: 'tc-1' },
    requestContext,
  } as never)
  assert.equal(client.created.length, 0)
})

test('disabled gate tools open nothing (env toggle)', async () => {
  const { plugin, client } = makePlugin({ env: { ...baseEnv, HITLY_GATE_PLAN: 'false' } })
  const { args } = toolEvent('submit_plan', { plan: 'x' })
  await plugin.postToolObserver!(args as never)
  assert.equal(client.created.length, 0)
})

test('observer failures never throw into the tool pipeline (Factory catches, we double-guard)', async () => {
  const client = { createApproval: async () => { throw new Error('hitly down') } } as unknown as HitlyClientLike
  const plugin = new HitlyMastraFactoryPlugin({ config: parseRuntimeConfig(baseEnv), client, seams: fakeSeams })
  const { args } = toolEvent('submit_plan', { plan: 'x' })
  await assert.doesNotReject(() => Promise.resolve(plugin.postToolObserver!(args as never)))
})

// ---------------------------------------------------------------------------
// Restart reconciliation: approvals opened before a Factory restart must be
// re-adopted from HITLy's authoritative feed and their decisions applied.
// ---------------------------------------------------------------------------

const SEED_METADATA = {
  'net.hitly/gate': 'plan',
  'net.hitly/factory/session-id': 'sess-1',
  'net.hitly/factory/tool-call-id': 'tc-1',
  'net.hitly/factory/org-id': 'org_1',
  'net.hitly/factory/user-id': 'user_1',
}

test('decisions made while the Factory was down are applied on the first reconcile tick', async () => {
  const parked: Array<Record<string, unknown>> = []
  const client = {
    createApproval: async () => ({ id: 'unused', status: 'pending' }),
    listPending: async () => [{ id: 'apv_pre_restart', status: 'pending', decision: null, metadata: SEED_METADATA }],
    getApproval: async (id: string) => ({ id, status: 'decided', decision: 'accept', metadata: SEED_METADATA }),
  }
  const plugin = new HitlyMastraFactoryPlugin({
    config: parseRuntimeConfig(baseEnv),
    client: client as unknown as HitlyPluginOptions['client'],
    seams: fakeSeams,
    applySeams: {
      answerParked: async (args) => void parked.push(args as unknown as Record<string, unknown>),
      signalSession: async () => {},
    },
  })
  const tick = await plugin.reconcileNow()
  assert.equal(tick.applied, 1)
  assert.equal(parked.length, 1)
  assert.equal(parked[0]!.decision, 'approve')
  assert.equal(parked[0]!.sessionId, 'sess-1')
  assert.equal(parked[0]!.toolCallId, 'tc-1')
  // Closed after apply: the next tick must not re-answer the parked call.
  const second = await plugin.reconcileNow()
  assert.equal(second.applied, 0)
  assert.equal(parked.length, 1)
})

test('a second process re-converging a failed_resume row counts it delivered, acks it, and stops replaying', async () => {
  // The B4 loop: process A converged the decision (or the "lost" callback
  // actually landed), but the HITLy row stayed failed_resume. Process B
  // re-seeds it, answerParkedCall throws "Nothing is waiting on that tool
  // call any more" — previously a permanent error loop. Now: delivered.
  const parked: unknown[] = []
  const acked: string[] = []
  const client = {
    createApproval: async () => ({ id: 'unused', status: 'pending' }),
    listPending: async () => [{ id: 'apv_fr', status: 'failed_resume', decision: 'accept', metadata: SEED_METADATA }],
    getApproval: async (id: string) => ({ id, status: 'failed_resume', decision: 'accept', metadata: SEED_METADATA }),
    ackResume: async (id: string) => void acked.push(id),
  }
  const plugin = new HitlyMastraFactoryPlugin({
    config: parseRuntimeConfig(baseEnv),
    client: client as unknown as HitlyPluginOptions['client'],
    seams: fakeSeams,
    applySeams: {
      answerParked: async () => {
        parked.push(1)
        throw new Error('Nothing is waiting on that tool call any more: the run that asked has ended or it was already answered.')
      },
      signalSession: async () => {},
    },
  })
  const first = await plugin.reconcileNow()
  assert.equal(first.applied, 1)
  assert.equal(first.errors, 0)
  assert.deepEqual(acked, ['apv_fr'])
  const second = await plugin.reconcileNow()
  assert.equal(second.applied, 0)
  assert.equal(parked.length, 1)
})

test('seeded gate-less or identity-less rows are skipped, never applied', async () => {
  const parked: unknown[] = []
  const client = {
    createApproval: async () => ({ id: 'unused', status: 'pending' }),
    listPending: async () => [
      { id: 'apv_nogate', status: 'pending', decision: null, metadata: { 'net.hitly/factory/session-id': 'sess-1' } },
      { id: 'apv_noident', status: 'pending', decision: null, metadata: { 'net.hitly/gate': 'plan' } },
    ],
    getApproval: async (id: string) => ({ id, status: 'decided', decision: 'accept', metadata: {} }),
  }
  const plugin = new HitlyMastraFactoryPlugin({
    config: parseRuntimeConfig(baseEnv),
    client: client as unknown as HitlyPluginOptions['client'],
    seams: fakeSeams,
    applySeams: { answerParked: async () => void parked.push(1), signalSession: async () => {} },
  })
  await plugin.reconcileNow()
  assert.equal(parked.length, 0)
})

// ---------------------------------------------------------------------------
// Server-subpath purity: apps/app must never need @mastra/* installed.
// ---------------------------------------------------------------------------

test('server subpath module graph contains zero @mastra imports', () => {
  const srcDir = dirname(new URL(import.meta.url).pathname)
  const seen = new Set<string>()
  const queue = ['server.ts']
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(join(srcDir, file), 'utf8')
    const importers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    for (const specifier of importers) {
      assert.equal(specifier.startsWith('@mastra/'), false, `${file} imports ${specifier} — server subpath must stay @mastra-free`)
      if (specifier.startsWith('.')) {
        const rel = resolve(dirname(join(srcDir, file)), specifier)
        const candidates = [`${rel}.ts`, `${rel}/index.ts`]
        for (const candidate of candidates) {
          try {
            readFileSync(candidate, 'utf8')
            queue.push(candidate.slice(srcDir.length + 1))
          } catch {
            /* not a local module file */
          }
        }
      }
    }
  }
  assert.equal(seen.has('server.ts'), true)
})

// ─── Registry mode: per-factory HITLy connections (#211) ─────────────────────

const FACTORY_BASE_URL = 'https://hitly.factory.example'
const FACTORY_API_KEY = 'htl_factory'
const FACTORY_PROJECT_ID = 'prj_factory'
const FACTORY_SECRET = 'whsec_factory'

function makeRegistry(opts: { envConfig?: ReturnType<typeof parseRuntimeConfig> | null; envFallback?: string; projects?: Array<{ id: string; orgId: string; name: string }> } = {}) {
  const settingsRows = new Map<string, unknown>()
  const directoryRows: Array<{ orgId: string; targetKey: string; data: unknown }> = []
  const clients = new Map<string, ReturnType<typeof fakeClient>>()
  const registry = new HitlyConnectionRegistry({
    settings: {
      get: async (orgId: string, userId: string) => (settingsRows.get(`${orgId}|${userId}`) ?? null) as never,
      save: async (orgId: string, userId: string, config: unknown) => {
        settingsRows.set(`${orgId}|${userId}`, config)
      },
    } as never,
    directory: {
      create: async (row: { orgId: string; targetKey: string; data: unknown }) => {
        const record = { id: `sub_${directoryRows.length + 1}`, ...row }
        directoryRows.push(record)
        return { id: record.id }
      },
      listByTarget: async (targetKey: string) => directoryRows.filter((r) => r.targetKey === targetKey),
      delete: async (id: string) => {
        const i = directoryRows.findIndex((r) => r.id === id)
        if (i >= 0) directoryRows.splice(i, 1)
      },
      deleteWhere: async (where: { orgId: string; targetKey?: string }) => {
        for (let i = directoryRows.length - 1; i >= 0; i--) {
          const row = directoryRows[i]!
          if (row.orgId === where.orgId && (!where.targetKey || row.targetKey === where.targetKey)) directoryRows.splice(i, 1)
        }
      },
    } as never,
    projects: {
      listAll: async () => opts.projects ?? [{ id: 'fproj_1', orgId: 'org_1', name: 'Primary' }],
    } as never,
    envConfig: opts.envConfig ?? null,
    envFallback: parseEnvFallback(opts.envFallback),
    clientFactory: (config) => {
      const key = `${config.hitlyBaseUrl}|${config.hitlyApiKey}|${config.projectId}`
      let client = clients.get(key)
      if (!client) {
        client = fakeClient()
        clients.set(key, client)
      }
      return client
    },
  })
  return { registry, clients, settingsRows, directoryRows }
}

function makeRegistryPlugin(opts: { useEnvConfig?: boolean; envFallback?: string; projects?: Array<{ id: string; orgId: string; name: string }> } = {}) {
  const config = parseRuntimeConfig(baseEnv)
  const { registry, clients, settingsRows, directoryRows } = makeRegistry({
    // In production createHitlyIntegration always passes the deployment env
    // config (publicBaseUrl is a deployment fact, never per-factory).
    envConfig: config,
    envFallback: opts.envFallback,
    projects: opts.projects,
  })
  const globalClient = fakeClient()
  const parked: Array<Record<string, unknown>> = []
  const signals: Array<Record<string, unknown>> = []
  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = []
  const plugin = new HitlyMastraFactoryPlugin({
    config,
    client: globalClient,
    seams: fakeSeams,
    registry,
    applySeams: {
      answerParked: async (args) => {
        parked.push(args as unknown as Record<string, unknown>)
      },
      deliverSignal: async (args) => {
        signals.push(args as unknown as Record<string, unknown>)
      },
    },
    log: (level, message, meta) => {
      logs.push({ level, message, meta })
    },
  })
  const factoryClient = () => clients.get(`${FACTORY_BASE_URL}|${FACTORY_API_KEY}|${FACTORY_PROJECT_ID}`)
  const envClient = () => clients.get(`${baseEnv.HITLY_API_URL}|${baseEnv.HITLY_API_KEY}|${baseEnv.HITLY_PROJECT_ID}`)
  const connect = () =>
    registry.save('org_1', 'user_1', 'fproj_1', {
      hitlyBaseUrl: FACTORY_BASE_URL,
      hitlyApiKey: FACTORY_API_KEY,
      projectId: FACTORY_PROJECT_ID,
      webhookSigningSecret: FACTORY_SECRET,
    })
  const resumeRoute = () => plugin.routes!({} as never).find((r) => r.path === `${RESUME_PATH}/:factoryProjectId`)!
  return { plugin, globalClient, registry, clients, settingsRows, directoryRows, parked, signals, logs, factoryClient, envClient, connect, resumeRoute }
}

async function openPlanApproval(t: ReturnType<typeof makeRegistryPlugin>) {
  const { args } = toolEvent('submit_plan', { plan: 'per-factory plan' })
  await t.plugin.postToolObserver!(args as never)
}

function resumeRequest(
  body: Record<string, unknown>,
  opts: { secret?: string; bearer?: string | null; eventId?: string; factoryProjectId?: string } = {},
) {
  const rawBody = JSON.stringify(body)
  const timestamp = Math.floor(Date.now() / 1000)
  const headers = new Headers({ 'content-type': 'application/json' })
  if (opts.bearer !== null) headers.set('authorization', `Bearer ${opts.bearer ?? (body.cbAuthToken as string)}`)
  headers.set(HEADER_TIMESTAMP, String(timestamp))
  headers.set(HEADER_SIGNATURE, signBody(opts.secret ?? FACTORY_SECRET, timestamp, rawBody))
  headers.set(HEADER_EVENT_ID, opts.eventId ?? (body.event_id as string) ?? 'evt_r1')
  headers.set(HEADER_KEY_ID, 'key_1')
  const fpid = opts.factoryProjectId ?? 'fproj_1'
  return new Request(`https://factory.example.com${RESUME_PATH}/${fpid}`, { method: 'POST', headers, body: rawBody })
}

function planAuthorityMetadata(factoryProjectId = 'fproj_1'): Record<string, unknown> {
  return {
    [METADATA_KEYS.gate]: 'plan',
    [METADATA_KEYS.sessionId]: 'sess-1',
    [METADATA_KEYS.toolCallId]: 'tc-1',
    [METADATA_KEYS.projectId]: factoryProjectId,
  }
}

test('registry: connected factory opens on its OWN HITLy client with a per-factory resumeUrl', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  await openPlanApproval(t)
  assert.equal(t.globalClient.created.length, 0, 'global client must stay unused in registry mode')
  const fc = t.factoryClient()!
  assert.equal(fc.created.length, 1)
  const payload = fc.created[0]!.body as Record<string, unknown>
  // resumeUrl points at the plugin's OWN resume endpoint on the Factory's
  // public URL — with the factory's id as a path segment (#211).
  assert.equal(payload.resumeUrl, `https://factory.example.com${RESUME_PATH}/fproj_1`)
})

test('registry: factory with no connection and no env fallback opens NOTHING', async () => {
  const t = makeRegistryPlugin()
  await openPlanApproval(t)
  assert.equal(t.globalClient.created.length, 0)
  assert.equal(t.clients.size, 0)
  assert.equal(t.logs.some((l) => l.level === 'warn' && /no connection for factory/i.test(l.message)), true)
})

test('registry: env-fallback factory uses the deployment env credentials', async () => {
  const t = makeRegistryPlugin({ useEnvConfig: true, envFallback: 'fproj_1' })
  await openPlanApproval(t)
  const ec = t.envClient()!
  assert.equal(ec.created.length, 1)
  const payload = ec.created[0]!.body as Record<string, unknown>
  assert.equal(String(payload.resumeUrl).endsWith(`${RESUME_PATH}/fproj_1`), true)
})

test('registry: resume callback verifies with THAT connection\u2019s secret and dispatches the decision', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  await openPlanApproval(t)
  const fc = t.factoryClient()!
  const created = fc.created[0]!
  const body = created.body as Record<string, unknown>
  fc.approvals = {
    apv_1: { id: 'apv_1', status: 'decided', decision: 'accept', metadata: planAuthorityMetadata() },
  }
  const res = await t.resumeRoute().handler(
    resumeRequest({ id: 'apv_1', event_id: 'evt_1', type: 'decided', cbAuthToken: body.cbAuthToken }),
  )
  assert.equal(res.status, 200)
  assert.equal(t.parked.length, 1)
  assert.equal(t.parked[0]!.decision, 'approve')
  assert.equal(t.parked[0]!.sessionId, 'sess-1')
})

test('registry: callback signed with the WRONG factory secret is rejected 401', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  await openPlanApproval(t)
  const fc = t.factoryClient()!
  const body = fc.created[0]!.body as Record<string, unknown>
  fc.approvals = { apv_1: { id: 'apv_1', status: 'decided', decision: 'accept', metadata: planAuthorityMetadata() } }
  const res = await t.resumeRoute().handler(
    resumeRequest({ id: 'apv_1', event_id: 'evt_1', type: 'decided', cbAuthToken: body.cbAuthToken }, { secret: 'whsec_other_factory' }),
  )
  assert.equal(res.status, 401)
  assert.equal(t.parked.length, 0)
})

test('registry: resume for an unknown factory project is 404', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  const res = await t.resumeRoute().handler(
    resumeRequest({ id: 'apv_1', event_id: 'evt_1', type: 'decided', cbAuthToken: 'tok' }, { factoryProjectId: 'fproj_unknown' }),
  )
  assert.equal(res.status, 404)
  assert.equal(t.parked.length, 0)
})

test('registry: cross-factory approval (metadata belongs to another factory) is rejected, never dispatched', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  await openPlanApproval(t)
  const fc = t.factoryClient()!
  const body = fc.created[0]!.body as Record<string, unknown>
  fc.approvals = {
    apv_1: { id: 'apv_1', status: 'decided', decision: 'accept', metadata: planAuthorityMetadata('fproj_some_other_factory') },
  }
  const res = await t.resumeRoute().handler(
    resumeRequest({ id: 'apv_1', event_id: 'evt_1', type: 'decided', cbAuthToken: body.cbAuthToken }),
  )
  assert.equal(res.status, 404)
  assert.equal(t.parked.length, 0)
})

test('registry: duplicate event id is applied once', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  await openPlanApproval(t)
  const fc = t.factoryClient()!
  const body = fc.created[0]!.body as Record<string, unknown>
  fc.approvals = { apv_1: { id: 'apv_1', status: 'decided', decision: 'accept', metadata: planAuthorityMetadata() } }
  const event = { id: 'apv_1', event_id: 'evt_dup', type: 'decided', cbAuthToken: body.cbAuthToken }
  const first = await t.resumeRoute().handler(resumeRequest(event))
  const second = await t.resumeRoute().handler(resumeRequest(event))
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(t.parked.length, 1)
})

test('registry: disconnect stops new asks immediately', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  await t.registry.disconnect('org_1', 'fproj_1')
  await openPlanApproval(t)
  assert.equal(t.globalClient.created.length, 0)
  assert.equal(t.factoryClient()?.created.length ?? 0, 0)
})

// ─── Registry mode: per-connection reconciliation (#211 Phase 4) ─────────────

const TWO_BASE_URL = 'https://hitly.two.example'
const TWO_API_KEY = 'htl_two'
const TWO_PROJECT_ID = 'prj_two'
const TWO_SECRET = 'whsec_two'

function seedRow(id: string, status: string, decision: string | null, factoryProjectId: string): FakeApproval {
  return {
    id,
    status,
    decision,
    metadata: {
      [METADATA_KEYS.gate]: 'plan',
      [METADATA_KEYS.sessionId]: `sess_${factoryProjectId}`,
      [METADATA_KEYS.toolCallId]: 'tc-1',
      [METADATA_KEYS.projectId]: factoryProjectId,
    },
  }
}

function twoProjects() {
  return [
    { id: 'fproj_1', orgId: 'org_1', name: 'Primary' },
    { id: 'fproj_2', orgId: 'org_2', name: 'Second' },
  ]
}

async function connectSecond(t: ReturnType<typeof makeRegistryPlugin>) {
  await t.registry.save('org_2', 'user_2', 'fproj_2', {
    hitlyBaseUrl: TWO_BASE_URL,
    hitlyApiKey: TWO_API_KEY,
    projectId: TWO_PROJECT_ID,
    webhookSigningSecret: TWO_SECRET,
  })
  return factoryClientOf(t, 'org_2', 'fproj_2')
}

// The registry creates clients lazily; resolve the connection first so the
// fake client exists before a test seeds its state.
async function factoryClientOf(t: ReturnType<typeof makeRegistryPlugin>, orgId = 'org_1', fpid = 'fproj_1') {
  const conn = await t.registry.resolve(orgId, fpid)
  if (!conn) throw new Error(`no connection for ${fpid}`)
  return t.registry.clientFor(conn) as ReturnType<typeof fakeClient>
}

test('registry: reconcile converges each connected factory through ITS OWN HITLy project', async () => {
  const t = makeRegistryPlugin({ projects: twoProjects() })
  await t.connect()
  const fc2 = await connectSecond(t)
  const fc1 = await factoryClientOf(t)
  fc1.pending = [seedRow('apv_a', 'failed_resume', 'accept', 'fproj_1')]
  fc1.approvals = { apv_a: seedRow('apv_a', 'failed_resume', 'accept', 'fproj_1') }
  fc2.pending = [seedRow('apv_b', 'pending', null, 'fproj_2')]
  fc2.approvals = { apv_b: seedRow('apv_b', 'decided', 'reject', 'fproj_2') }
  const tick = await t.plugin.reconcileNow()
  assert.equal(tick.checked, 2)
  assert.equal(tick.applied, 2)
  assert.equal(t.globalClient.created.length, 0, 'global client must stay unused in registry mode')
  // The failed_resume row gets a settle ack on its OWN project; the plain
  // decided row does not.
  assert.deepEqual(fc1.acked, ['apv_a'])
  assert.deepEqual(fc2.acked, [])
  const bySession = new Map(t.parked.map((p) => [p.sessionId, p.decision]))
  assert.equal(bySession.get('sess_fproj_1'), 'approve')
  assert.equal(bySession.get('sess_fproj_2'), 'decline')
})

test('registry: HITLy gate config wins per connection; outages keep last-known gates (fail-closed)', async () => {
  const t = makeRegistryPlugin()
  await t.connect()
  const fc = await factoryClientOf(t)
  fc.remoteConfig = { gates: { plan: false, review: true, ask_user: true }, mergeAfterAccept: true }
  const tick = await t.plugin.reconcileNow()
  assert.equal(tick.configRefreshed, true)
  type Row = { gates: Record<Gate, boolean>; mergeAfterAccept: boolean }
  const row = () => t.settingsRows.get('org_1|factory:fproj_1') as Row
  assert.equal(row().gates.plan, false)
  assert.equal(row().mergeAfterAccept, true)
  // The factory now honors its own (HITLy-authoritative) gate toggles.
  await openPlanApproval(t)
  assert.equal(fc.created.length, 0, 'plan gate closed by HITLy config must open nothing')
  // Unreachable HITLy: keep last-known gates, never silently re-open them.
  fc.unreachable = true
  const down = await t.plugin.reconcileNow()
  assert.equal(down.configRefreshed, false)
  assert.equal(row().gates.plan, false)
})

test('registry: one unreachable HITLy records its error and does not block other factories', async () => {
  const t = makeRegistryPlugin({ projects: twoProjects() })
  await t.connect()
  const fc2 = await connectSecond(t)
  const fc1 = await factoryClientOf(t)
  fc1.unreachable = true
  fc2.pending = [seedRow('apv_b', 'pending', null, 'fproj_2')]
  fc2.approvals = { apv_b: seedRow('apv_b', 'decided', 'accept', 'fproj_2') }
  const tick = await t.plugin.reconcileNow()
  assert.equal(tick.applied, 1, 'the healthy factory still converges')
  assert.ok(tick.errors >= 1)
  type Row = { lastError?: string | null }
  const row1 = t.settingsRows.get('org_1|factory:fproj_1') as Row
  assert.ok(row1.lastError && /unreachable/.test(row1.lastError), 'failed factory records its status')
})

test('registry: settings routes mount only when a registry is wired', () => {
  const t = makeRegistryPlugin()
  const auth = {
    enabled: () => true,
    ensureUser: async () => undefined,
    tenant: () => ({ orgId: 'org_1', userId: 'user_1' }),
    isOrganizationAdmin: async () => true,
  }
  const routes = t.plugin.routes!({ auth, storage: { projects: { listAll: async () => [] } } } as never)
  for (const path of [
    '/web/integrations/hitly/settings',
    '/web/integrations/hitly/settings/api',
    '/web/integrations/hitly/settings/connect',
    '/web/integrations/hitly/settings/disconnect',
    '/web/integrations/hitly/settings/test',
  ]) {
    assert.ok(routes.some((r) => r.path === path), `settings route ${path}`)
  }
  const legacy = makePlugin().plugin.routes!({} as never)
  assert.ok(!legacy.some((r) => r.path.startsWith('/web/integrations/hitly/settings')))
})
