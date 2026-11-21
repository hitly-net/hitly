import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handleIngestPost } from './ingest-route'

const KEY = 'hitly_' + 'b'.repeat(32)

function post(body?: unknown): Request {
  return new Request('http://localhost:3001/api/v1/approvals', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/**
 * REST surface of the decision cap: a tier refusal from the ingest write
 * path (stable code + human message + 402) must reach the API caller
 * unchanged — same body fields the idempotency conflict mapping uses.
 */
describe('POST /api/v1/approvals tier refusal', () => {
  it('a tier_limit_reached ingest refusal answers 402 with the stable code and message', async () => {
    const message = 'Monthly decision limit reached (2 of 2 decisions used this month). Upgrade to allow more decisions per month.'
    const response = await handleIngestPost(post({ plugin: 'http', actionName: 'a', args: {} }), {
      authenticate: async () => ({ project: { id: 'prj_x' } }),
      acquire: () => ({ allowed: true, retryAfterMs: 0, count: 1 }),
      ingest: async () => ({
        ok: false as const,
        error: message,
        code: 'tier_limit_reached' as const,
        status: 402 as const,
      }),
      log: () => {},
    })
    assert.equal(response.status, 402)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.code, 'tier_limit_reached')
    assert.equal(body.error, message)
  })

  it('a non-tier ingest refusal keeps its own code (mapping stays generic)', async () => {
    const response = await handleIngestPost(post({ plugin: 'http', actionName: 'a', args: {} }), {
      authenticate: async () => ({ project: { id: 'prj_x' } }),
      acquire: () => ({ allowed: true, retryAfterMs: 0, count: 1 }),
      ingest: async () => ({
        ok: false as const,
        error: 'Idempotency-Key reused with a different payload',
        code: 'idempotency_conflict' as const,
        status: 409 as const,
      }),
      log: () => {},
    })
    assert.equal(response.status, 409)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.code, 'idempotency_conflict')
  })
})
