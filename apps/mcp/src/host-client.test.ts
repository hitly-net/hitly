import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpHostClient } from './host-client.ts'
import { TEST_KEY } from './test-helpers.ts'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown, calls: Call[]) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

test('ingest POSTs /api/v1/approvals with Bearer key and Idempotency-Key', async () => {
  const calls: Call[] = []
  const client = new HttpHostClient('https://hitly.example', TEST_KEY, fakeFetch(200, { id: 'apr_1', status: 'pending', replayed: false }, calls))
  const result = await client.ingest({ plugin: 'http' }, 'idem-0001')
  assert.deepEqual(result, { ok: true, status: 200, data: { id: 'apr_1', status: 'pending', replayed: false } })
  assert.equal(calls[0].url, 'https://hitly.example/api/v1/approvals')
  assert.equal(calls[0].init.method, 'POST')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.authorization, `Bearer ${TEST_KEY}`)
  assert.equal(headers['idempotency-key'], 'idem-0001')
  assert.equal(calls[0].init.redirect, 'manual')
})

test('reads, list and cancel hit the plural REST paths', async () => {
  const calls: Call[] = []
  const client = new HttpHostClient('https://hitly.example', TEST_KEY, fakeFetch(200, {}, calls))
  await client.getApproval('apr_1')
  await client.listPending('prj_1')
  await client.cancel('apr_1', 'stop')
  assert.deepEqual(
    calls.map((call) => `${call.init.method} ${call.url}`),
    [
      'GET https://hitly.example/api/v1/approvals/apr_1',
      'GET https://hitly.example/api/v1/approvals?status=pending&projectId=prj_1',
      'POST https://hitly.example/api/v1/approvals/apr_1/cancel',
    ],
  )
  assert.equal(calls[2].init.body, JSON.stringify({ reason: 'stop' }))
})

test('host errors map to codes; network failure is unreachable', async () => {
  const cases: [number, string][] = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'not_supported_by_host'],
    [400, 'invalid_request'],
    [500, 'host_error'],
  ]
  for (const [status, code] of cases) {
    const client = new HttpHostClient('https://hitly.example', TEST_KEY, fakeFetch(status, { error: 'nope' }, []))
    const result = await client.getApproval('apr_1')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, code)
  }
  const down = new HttpHostClient('https://hitly.example', TEST_KEY, async () => {
    throw new Error('connect ECONNREFUSED')
  })
  const result = await down.getApproval('apr_1')
  assert.deepEqual(result, { ok: false, status: 502, error: 'HITLy host unreachable', code: 'unreachable' })
})
