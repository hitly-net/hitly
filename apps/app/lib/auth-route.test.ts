import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'

// The 503 case below needs a process with no auth instance. Each test file
// runs in its own process, so clearing DATABASE_URL here (before the route
// module is loaded) keeps these tests independent of the runner's database.
delete process.env.DATABASE_URL

async function loadRoute() {
  return import('../app/api/auth/[...all]/route')
}

/**
 * Auth catch-all path handling: unknown auth paths must resolve to a JSON
 * 404, never a 500. handleAuthRequest normalises the auth handler's replies;
 * better-auth itself answers unmatched paths with a bare 404.
 */

function request() {
  return new Request('http://localhost:3001/api/auth/unknown-path', { method: 'POST' })
}

describe('auth catch-all 404 handling', () => {
  it('applies withNativeAuthOrigin before calling the auth handler', async () => {
    const { handleAuthRequest } = await loadRoute()
    let seen: Request | null = null
    const capture = async (req: Request) => {
      seen = req
      return NextResponse.json({ ok: true })
    }
    // No Origin header: the wrapper must supply the app origin.
    await handleAuthRequest(new Request('http://localhost:3001/api/auth/get-session', { method: 'GET' }), capture)
    assert.ok(seen, 'the handler must be called')
    assert.equal((seen as Request).headers.get('origin'), 'http://localhost:3001')

    // An existing Origin header is passed through unchanged.
    seen = null
    await handleAuthRequest(
      new Request('http://localhost:3001/api/auth/get-session', {
        method: 'GET',
        headers: { origin: 'https://app.example.com' },
      }),
      capture,
    )
    assert.equal((seen as Request | null)?.headers.get('origin'), 'https://app.example.com')
  })

  it('turns better-auth bare 404 replies into a JSON 404', async () => {
    const { handleAuthRequest } = await loadRoute()
    const bare404 = async () => new Response(null, { status: 404, statusText: 'Not Found' })
    const response = await handleAuthRequest(request(), bare404)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  })

  it('maps a missing (non-Response) result to a JSON 404', async () => {
    const { handleAuthRequest } = await loadRoute()
    const noResponse = async () => undefined as unknown as Response
    const response = await handleAuthRequest(request(), noResponse)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await response.json(), { error: 'Not found' })
  })

  it('passes real handler responses through untouched', async () => {
    const { handleAuthRequest } = await loadRoute()
    const ok = NextResponse.json({ ok: true })
    const response = await handleAuthRequest(request(), async () => ok)
    assert.equal(response.status, 200)
    assert.equal(response, ok)
  })

  it('reports 503 (database not configured) rather than 500 when no auth instance exists', async () => {
    // DATABASE_URL is cleared above, so the module auth instance is null;
    // an unconfigured surface is a clean 503, not a crash.
    const { GET } = await loadRoute()
    const response = await GET(request())
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Database not configured' })
  })
})
