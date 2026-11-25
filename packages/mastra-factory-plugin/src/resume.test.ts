import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signBody, HEADER_SIGNATURE, HEADER_TIMESTAMP, HEADER_EVENT_ID, HEADER_KEY_ID } from '@hitly/plugin-http'
import { handleResumeRequest, type ResumeDeps } from './resume.ts'
import type { PluginRuntimeConfig } from './types.ts'

const SECRET = 'whsec_test_123'
const BEARER = 'cb_bearer_secret'

const config: PluginRuntimeConfig = {
  hitlyBaseUrl: 'https://hitly.example.com',
  hitlyApiKey: 'hk_test_1',
  projectId: 'proj-1',
  publicBaseUrl: 'https://factory.example.com',
  callbackBearer: BEARER,
  resumeSecrets: [SECRET],
  gates: { plan: true, review: true, ask_user: true },
  mergeAfterAccept: false,
  pollIntervalMs: 30000,
}

const NOW = 1_753_500_000

function decidedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt_1',
    type: 'decided',
    request_id: 'factory:sess-1:tc-1',
    occurred_at: new Date(NOW * 1000).toISOString(),
    state: 'decided',
    decision: 'accept',
    id: 'apv_1',
    metadata: { 'net.hitly/gate': 'plan', 'net.hitly/factory/session-id': 'sess-1' },
    ...overrides,
  }
}

function makeRequest(body: unknown, opts: { bearer?: string | null; secret?: string; timestamp?: number; eventId?: string | null; keyId?: string | null } = {}) {
  const rawBody = JSON.stringify(body)
  const timestamp = opts.timestamp ?? NOW
  const secret = opts.secret ?? SECRET
  const headers = new Headers({ 'content-type': 'application/json' })
  if (opts.bearer !== null) headers.set('authorization', `Bearer ${opts.bearer ?? BEARER}`)
  headers.set(HEADER_TIMESTAMP, String(timestamp))
  headers.set(HEADER_SIGNATURE, signBody(secret, timestamp, rawBody))
  headers.set(HEADER_EVENT_ID, opts.eventId === null ? '' : (opts.eventId ?? (body as { event_id?: string }).event_id ?? 'evt_x'))
  if (opts.keyId !== null) headers.set(HEADER_KEY_ID, 'key_1')
  return { headers, rawBody }
}

function fakeDeps(overrides: Partial<ResumeDeps> = {}): ResumeDeps & { dispatched: unknown[]; seen: Set<string> } {
  const dispatched: unknown[] = []
  const seen = new Set<string>()
  return {
    dispatched,
    seen,
    dedupe: {
      check: (id) => seen.has(id),
      remember: (id) => seen.add(id),
    },
    fetchApprovalState: async (id) => ({
      id,
      status: 'decided',
      decision: 'accept',
      metadata: { 'net.hitly/gate': 'plan', 'net.hitly/factory/session-id': 'sess-1' },
    }),
    apply: async (cmd) => {
      dispatched.push(cmd)
      return { applied: true }
    },
    log: () => {},
    ...overrides,
  }
}

test('valid signed + bearer-authenticated callback dispatches the decision', async () => {
  const req = makeRequest(decidedEvent())
  const deps = fakeDeps()
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 200)
  assert.equal(deps.dispatched.length, 1)
  const cmd = deps.dispatched[0] as { approvalId: string; decision: string; gate: string }
  assert.equal(cmd.approvalId, 'apv_1')
  assert.equal(cmd.decision, 'accept')
  assert.equal(cmd.gate, 'plan')
})

test('missing bearer token is rejected 401 and never dispatched', async () => {
  const req = makeRequest(decidedEvent(), { bearer: null })
  const deps = fakeDeps()
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 401)
  assert.equal(deps.dispatched.length, 0)
})

test('wrong bearer token is rejected 401', async () => {
  const req = makeRequest(decidedEvent(), { bearer: 'attacker' })
  const deps = fakeDeps()
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 401)
  assert.equal(deps.dispatched.length, 0)
})

test('forged signature is rejected 401 even with a valid bearer', async () => {
  const req = makeRequest(decidedEvent(), { secret: 'not_the_real_secret' })
  const deps = fakeDeps()
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 401)
  assert.equal(deps.dispatched.length, 0)
})

test('body tampering after signing is rejected (signature covers raw body)', async () => {
  const event = decidedEvent()
  const req = makeRequest(event)
  const tampered = JSON.stringify({ ...event, decision: 'accept', metadata: { 'net.hitly/gate': 'review' } })
  const deps = fakeDeps()
  const res = await handleResumeRequest({ headers: req.headers, rawBody: tampered, config, deps }, NOW)
  assert.equal(res.status, 401)
  assert.equal(deps.dispatched.length, 0)
})

test('stale timestamp beyond the 5-minute window is rejected 401', async () => {
  const req = makeRequest(decidedEvent(), { timestamp: NOW - 6 * 60 })
  const deps = fakeDeps()
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 401)
  assert.equal(deps.dispatched.length, 0)
})

test('missing signature headers are rejected 401', async () => {
  const headers = new Headers({ authorization: `Bearer ${BEARER}` })
  const deps = fakeDeps()
  const res = await handleResumeRequest({ headers, rawBody: JSON.stringify(decidedEvent()), config, deps }, NOW)
  assert.equal(res.status, 401)
  assert.equal(deps.dispatched.length, 0)
})

test('duplicate event id is acknowledged once-dispatched but never re-dispatched', async () => {
  const req = makeRequest(decidedEvent())
  const deps = fakeDeps()
  const first = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  const second = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200) // 200 so HITLy stops retrying
  assert.equal(deps.dispatched.length, 1)
})

test('second secret in the rotated list verifies (comma-separated env rotation)', async () => {
  const req = makeRequest(decidedEvent(), { secret: 'whsec_rotated' })
  const deps = fakeDeps()
  const res = await handleResumeRequest({
    headers: req.headers,
    rawBody: req.rawBody,
    config: { ...config, resumeSecrets: [SECRET, 'whsec_rotated'] },
    deps,
  }, NOW)
  assert.equal(res.status, 200)
  assert.equal(deps.dispatched.length, 1)
})

test('authoritative HITLy status overrides the callback claim: pending is not decided', async () => {
  // Forgery can't even reach here (signature fails), but a RACE where HITLy says the
  // approval is still pending must never apply. HITLy state is the authority.
  const req = makeRequest(decidedEvent())
  const deps = fakeDeps({
    fetchApprovalState: async (id) => ({ id, status: 'pending', decision: null, metadata: {} }),
  })
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 200)
  assert.equal(deps.dispatched.length, 0)
})

test('transient HITLy state fetch failure returns 502 so delivery retries', async () => {
  const req = makeRequest(decidedEvent())
  const deps = fakeDeps({
    fetchApprovalState: async () => {
      throw Object.assign(new Error('boom'), { status: 503 })
    },
  })
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 502)
  assert.equal(deps.dispatched.length, 0)
})

test('lifecycle events (expired/cancelled) are acknowledged without applying a decision', async () => {
  for (const type of ['expired', 'cancelled', 'opened'] as const) {
    const req = makeRequest(decidedEvent({ type, event_id: `evt_${type}` }))
    const deps = fakeDeps()
    const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
    assert.equal(res.status, 200, type)
    assert.equal(deps.dispatched.length, 0, type)
  }
})

test('a decided callback for an expired approval never dispatches (expiry is not approval)', async () => {
  const req = makeRequest(decidedEvent())
  const deps = fakeDeps({
    fetchApprovalState: async (id) => ({ id, status: 'expired', decision: 'accept', metadata: {} }),
  })
  const res = await handleResumeRequest({ headers: req.headers, rawBody: req.rawBody, config, deps }, NOW)
  assert.equal(res.status, 200)
  assert.equal(deps.dispatched.length, 0)
})
