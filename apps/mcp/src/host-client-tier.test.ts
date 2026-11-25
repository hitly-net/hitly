import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpHostClient } from './host-client.ts'
import { TEST_KEY } from './test-helpers.ts'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown, calls: Call[]) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

/**
 * The host answers tier refusals with 402 + a stable machine code and a
 * human message. The adapter must keep the code (bots branch on it), not
 * flatten the 402 to 'invalid_request'.
 */
test('ingest 402 with code tier_limit_reached keeps the stable code', async () => {
  const calls: Call[] = []
  const message = 'Monthly decision limit reached (300 of 300 decisions used this month). Upgrade to allow more decisions per month.'
  const client = new HttpHostClient('https://hitly.example', TEST_KEY, fakeFetch(402, { error: message, code: 'tier_limit_reached' }, calls))
  const result = await client.ingest({ plugin: 'http' }, 'idem-1')
  assert.equal(result.ok, false)
  if (result.ok) return assert.fail('unreachable')
  assert.equal(result.status, 402)
  assert.equal(result.code, 'tier_limit_reached')
  assert.equal(result.error, message)
})

test('a 402 without the tier code still maps through status (invalid_request)', async () => {
  const calls: Call[] = []
  const client = new HttpHostClient('https://hitly.example', TEST_KEY, fakeFetch(402, { error: 'pay up' }, calls))
  const result = await client.ingest({ plugin: 'http' }, 'idem-2')
  assert.equal(result.ok, false)
  if (result.ok) return assert.fail('unreachable')
  assert.equal(result.code, 'invalid_request')
})
