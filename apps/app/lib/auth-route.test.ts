import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import { GET, handleAuthRequest } from '../app/api/auth/[...all]/route'

/**
 * Auth catch-all path handling: unknown auth paths must resolve to a JSON
 * 404, never a 500. handleAuthRequest normalises the auth handler's replies;
 * better-auth itself answers unmatched paths with a bare 404.
 */

function request() {
  return new Request('http://localhost:3001/api/auth/unknown-path', { method: 'POST' })
}

describe('auth catch-all 404 handling', () => {
  it('turns better-auth bare 404 replies into a JSON 404', async () => {
    const bare404 = async () => new Response(null, { status: 404, statusText: 'Not Found' })
    const response = await handleAuthRequest(request(), bare404)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  })

  it('maps a missing (non-Response) result to a JSON 404', async () => {
    const noResponse = async () => undefined as unknown as Response
    const response = await handleAuthRequest(request(), noResponse)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  })

  it('passes real handler responses through untouched', async () => {
    const ok = NextResponse.json({ ok: true })
    const response = await handleAuthRequest(request(), async () => ok)
    assert.equal(response.status, 200)
    assert.equal(response, ok)
  })

  it('reports 503 (database not configured) rather than 500 when no auth instance exists', async () => {
    // Under test no database is configured, so the module auth instance is
    // null; an unconfigured surface is a clean 503, not a crash.
    const response = await GET(request())
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Database not configured' })
  })
})
