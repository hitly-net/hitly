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

test('getApproval reads authoritative status for the poller', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { id: 'apv_1', status: 'decided', decision: 'accept' } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const approval = await client.getApproval('apv_1')
  assert.equal(approval.status, 'decided')
  assert.equal(approval.decision, 'accept')
  assert.match(calls[0]!.url, /\/api\/v1\/approvals\/apv_1$/)
})

test('listPending fetches only open approvals for reconciliation', async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { approvals: [{ id: 'apv_9', status: 'pending' }] } }))
  const client = new HitlyClient({ ...config, fetchImpl })
  const list = await client.listPending()
  assert.equal(list.approvals[0]!.id, 'apv_9')
  assert.match(calls[0]!.url, /status=pending/)
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
