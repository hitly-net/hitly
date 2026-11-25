import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HitlyMastraFactoryPlugin } from './index.ts'
import type { HitlyClientLike } from './gates.ts'
import { parseRuntimeConfig } from './config.ts'

const baseEnv = {
  HITLY_API_URL: 'https://hitly.example.com',
  HITLY_API_KEY: 'hk_test_1',
  HITLY_PROJECT_ID: 'proj-1',
  HITLY_PUBLIC_URL: 'https://factory.example.com',
  HITLY_CALLBACK_BEARER: 'cb_secret',
  HITLY_RESUME_SECRETS: 'whsec_a',
}

function fakeClient(): HitlyClientLike & { created: Array<{ body: unknown; key: string }> } {
  const created: Array<{ body: unknown; key: string }> = []
  return {
    created,
    createApproval: async (body, idempotencyKey) => {
      created.push({ body, key: idempotencyKey })
      return { id: `apv_${created.length}`, status: 'pending' }
    },
  }
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
  assert.equal(routes.some((r) => r.path === '/api/integrations/hitly/resume'), true)
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
  assert.match(String(payload.resumeUrl), /^https:\/\/factory\.example\.com\/api\/integrations\/hitly\/resume$/)
  assert.match(key, /sess-1.*tc-1/)
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
