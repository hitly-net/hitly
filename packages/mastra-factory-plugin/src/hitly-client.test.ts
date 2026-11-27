import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HitlyClient, IDEMPOTENCY_CONFLICT } from './hitly-client.ts'

function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    calls.push({ url: target, init: init ?? {} })
    const { status, body } = handler(target, init ?? {})
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const config = {
  hitlyBaseUrl: 'https://hitly.example.com',
  hitlyApiKey: 'hk_test_1',
  projectId: 'proj-1',
}

test('createApproval posts Bearer auth, project id, and Idempotency-Key', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: { id: 'apv_1', status: 'pending' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const approval = await client.createApproval({ plugin: 'mastra-factory', runId: 'r1' }, 'idem-1')
  assert.equal(approval.id, 'apv_1')
  assert.equal(calls[0]!.url, 'https://hitly.example.com/api/v1/approvals')
  const headers = new Headers(calls[0]!.init.headers)
  assert.equal(headers.get('authorization'), 'Bearer hk_test_1')
  assert.equal(headers.get('idempotency-key'), 'idem-1')
  const sent = JSON.parse(String(calls[0]!.init.body))
  assert.equal(sent.plugin, 'mastra-factory')
})

test('same-key replay (200 with existing approval) is treated as success, not error', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: { id: 'apv_existing', status: 'pending' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const approval = await client.createApproval({ plugin: 'mastra-factory', runId: 'r1' }, 'idem-1')
  assert.equal(approval.id, 'apv_existing')
})

test('idempotency conflict (409) surfaces as typed error, never a silent duplicate', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 409, body: { error: 'idempotency_conflict' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await assert.rejects(
    () => client.createApproval({ plugin: 'mastra-factory', runId: 'r1' }, 'idem-used-differently'),
    (error: unknown) => error instanceof IDEMPOTENCY_CONFLICT,
  )
})

test('plugin mismatch (400) surfaces as typed error', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 400, body: { error: 'plugin_mismatch', message: 'Plugin mismatch: expected mastra-factory' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await assert.rejects(() => client.createApproval({ plugin: 'http', runId: 'r1' }, 'idem-1'), /mismatch/i)
})

test('getApproval reads authoritative state from the plugin integration endpoint', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: {
      id: 'apv_1',
      status: 'decided',
      decision: 'accept',
      metadata: { 'net.hitly/gate': 'plan', 'net.hitly/factory/session-id': 'sess-1' },
      reason: 'ship it',
    },
  }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const approval = await client.getApproval('apv_1')
  assert.equal(approval.status, 'decided')
  assert.equal(approval.decision, 'accept')
  assert.equal(approval.metadata['net.hitly/gate'], 'plan')
  assert.equal(approval.reason, 'ship it')
  // Authority must come from the plugin's key-scoped integration namespace,
  // the only read that guarantees the gate/session metadata.
  assert.match(calls[0]!.url, /\/api\/v1\/projects\/[^/]+\/integrations\/mastra-factory\/approvals\/apv_1$/)
})

test('listPending returns an array with create-time metadata for restart seeding', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: {
      approvals: [
        {
          id: 'apv_9',
          status: 'pending',
          decision: null,
          gate: 'plan',
          metadata: { 'net.hitly/gate': 'plan', 'net.hitly/factory/session-id': 'sess-1', 'net.hitly/factory/tool-call-id': 'tc-1' },
        },
      ],
    },
  }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const list = await client.listPending()
  assert.equal(Array.isArray(list), true)
  assert.equal(list[0]!.id, 'apv_9')
  // The seed feed must carry the identity the reconciler re-adopts with —
  // without it, approvals opened before a Factory restart could never resume.
  assert.equal(list[0]!.metadata['net.hitly/factory/session-id'], 'sess-1')
  assert.match(calls[0]!.url, /\/api\/v1\/projects\/[^/]+\/integrations\/mastra-factory\/approvals$/)
})

test('listPending tolerates a malformed body without throwing', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 200, body: { unexpected: 'shape' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const list = await client.listPending()
  assert.deepEqual(list, [])
})

test('ackResume POSTs the host receipt to the resume-ack endpoint', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { id: 'apv_1', status: 'decided' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await client.ackResume('apv_1')
  assert.match(calls[0]!.url, /\/api\/v1\/projects\/proj-1\/integrations\/mastra-factory\/approvals\/apv_1\/resume-ack$/)
  assert.equal(calls[0]!.init.method, 'POST')
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer hk_test_1')
})

test('ackResume throws on non-200 so the reconciler can log a lost ack', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 503, body: { error: 'unavailable' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await assert.rejects(() => client.ackResume('apv_1'), /503|unavailable/i)
})

test('server errors throw with status for retry/backoff decisions', async () => {
  const { fetchImpl } = stubFetch(() => ({ status: 503, body: { error: 'unavailable' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await assert.rejects(() => client.getApproval('apv_1'), (error: unknown) => (error as { status?: number }).status === 503)
})

test('config endpoint read returns gate state from HITLy (source of truth)', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({
    status: 200,
    body: { gates: { plan: true, review: true, ask_user: false }, mergeAfterAccept: true },
  }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const remote = await client.getIntegrationConfig()
  assert.deepEqual(remote.gates, { plan: true, review: true, ask_user: false })
  assert.equal(remote.mergeAfterAccept, true)
  assert.match(calls[0]!.url, /\/api\/v1\/projects\/proj-1\/integrations\/mastra-factory$/)
})

// ---------------------------------------------------------------------------
// Requester cancel (closes a gate the Factory surface decided) and the
// best-effort conflict annotation (#213 endpoint, absent until it lands).
// ---------------------------------------------------------------------------

test('cancelApproval POSTs the decided-elsewhere reason to the requester cancel endpoint', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { id: 'apv_1', status: 'cancelled' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await client.cancelApproval('apv_1', 'Decided in Mastra Factory: approved')
  assert.equal(calls[0]!.url, 'https://hitly.example.com/api/v1/approvals/apv_1/cancel')
  assert.equal(calls[0]!.init.method, 'POST')
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer hk_test_1')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { reason: 'Decided in Mastra Factory: approved' })
})

test('cancelApproval sends an empty body without a reason and accepts 204', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    // 204 must carry no body, so this cannot go through the JSON stub helper.
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  const client = new HitlyClient({ ...config, fetchImpl })
  await client.cancelApproval('apv_1')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {})
})

test('cancelApproval surfaces 409 with its status so the caller can read the authority', async () => {
  // 409 means HITLy no longer awaits a decision — usually a reviewer decided
  // first (mid-air). The caller must be able to tell that from a network error.
  const { fetchImpl } = stubFetch(() => ({ status: 409, body: { error: 'conflict', message: 'Approval is not awaiting a decision' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await assert.rejects(
    () => client.cancelApproval('apv_1', 'Decided in Mastra Factory: approved'),
    (error: unknown) => (error as { status?: number }).status === 409,
  )
})

test('annotateApproval records a conflict note when HITLy accepts it', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: { id: 'ann_1' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const result = await client.annotateApproval('apv_1', 'HITLy decided first')
  assert.deepEqual(result, { recorded: true })
  assert.match(calls[0]!.url, /\/api\/v1\/approvals\/apv_1\/annotations$/)
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { note: 'HITLy decided first' })
})

test('annotateApproval is best-effort: a missing #213 endpoint reports recorded=false and never throws', async () => {
  for (const status of [404, 405, 500]) {
    const { fetchImpl } = stubFetch(() => ({ status, body: { error: 'not_found' } }))
    const client = new HitlyClient({ ...config, fetchImpl })
    assert.deepEqual(await client.annotateApproval('apv_1', 'note'), { recorded: false }, String(status))
  }
})

test('annotateApproval swallows transport failures — a lost note must not change what happens to a decision', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  const client = new HitlyClient({ ...config, fetchImpl })
  assert.deepEqual(await client.annotateApproval('apv_1', 'note'), { recorded: false })
})

// --- request deadline -------------------------------------------------------
// The observer path runs inline with the tool pipeline, so every HITLy call
// has to carry a deadline: a wedged server must not be able to hold a tool
// call (or a reconciler tick) open forever.

test('every HITLy call carries an abort signal so a wedged server cannot hang the caller', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { id: 'apv_1', status: 'pending' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  await client.createApproval({ plugin: 'mastra-factory', runId: 'r1' }, 'idem-1')
  await client.getApproval('apv_1')
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal, `signal on ${call.url}`)
  }
})

test('a server that never answers is cut off at the deadline', async () => {
  // Stands in for a hung connection: resolves only when the caller aborts,
  // with the abort reason — which is what fetch does on the wire.
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal
    if (!signal) throw new Error('no deadline was passed — the call would hang forever')
    // AbortSignal.timeout does not keep the event loop alive on its own.
    const hold = setTimeout(() => undefined, 2_000)
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        clearTimeout(hold)
        reject(signal.reason)
      }, { once: true })
    })
  }) as unknown as typeof fetch
  const client = new HitlyClient({ ...config, fetchImpl, requestTimeoutMs: 25 })
  await assert.rejects(() => client.createApproval({ plugin: 'mastra-factory', runId: 'r1' }, 'idem-1'), /abort|timeout/i)
})

test('requestTimeoutMs: 0 opts out of the deadline', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: { id: 'apv_1', status: 'pending' } }))
  const client = new HitlyClient({ ...config, fetchImpl, requestTimeoutMs: 0 })
  await client.createApproval({ plugin: 'mastra-factory', runId: 'r1' }, 'idem-1')
  assert.equal(calls[0]!.init.signal, undefined)
})
