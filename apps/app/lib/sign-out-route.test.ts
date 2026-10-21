import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { isJsonContentType, isSameOrigin, POST } from '../app/api/session/sign-out/route'

/**
 * Request policy tests for the sign-out route (/api/session/sign-out).
 *
 * The route accepts only same-origin requests (Origin header matches the
 * configured app URL) carrying a JSON content type. Rejections happen before
 * any session work: 403 for origin, 415 for content type.
 */

const APP_ORIGIN_URL = 'http://localhost:3001/api/session/sign-out'

function requestWith(options: { origin?: string; contentType?: string | null }): NextRequest {
  const headers: Record<string, string> = { cookie: 'better-auth.session_token=fake' }
  if (options.origin !== undefined) headers['origin'] = options.origin
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json'
  return new NextRequest(APP_ORIGIN_URL, {
    method: 'POST',
    headers,
    body: '{}',
  })
}

describe('sign-out route request policy', () => {
  it('classifies JSON content types, allowing a charset parameter', () => {
    assert.equal(isJsonContentType('application/json'), true)
    assert.equal(isJsonContentType('application/json;charset=utf-8'), true)
    assert.equal(isJsonContentType('Application/JSON; charset=UTF-8'), true)
    assert.equal(isJsonContentType('text/plain'), false)
    assert.equal(isJsonContentType('multipart/form-data'), false)
    assert.equal(isJsonContentType(null), false)
  })

  it('compares the Origin header against the configured app origin', () => {
    assert.equal(isSameOrigin('http://localhost:3001'), true)
    assert.equal(isSameOrigin('http://localhost:3002'), false)
    assert.equal(isSameOrigin('https://hitly.example'), false)
    assert.equal(isSameOrigin(null), false)
    assert.equal(isSameOrigin('not-a-url'), false)
  })

  it('accepts only the exact JSON content type', () => {
    for (const type of ['application/jsonx', 'application/json-patch+json', 'application/jsonp', 'xapplication/json', 'application/json5', 'text/json']) {
      assert.equal(isJsonContentType(type), false, type)
    }
  })

  it('rejects application/jsonx with 415', async () => {
    const response = await POST(requestWith({ origin: 'http://localhost:3001', contentType: 'application/jsonx' }))
    assert.equal(response.status, 415)
    assert.deepEqual(await response.json(), { error: 'unsupported_media_type' })
  })

  it('matches the origin exactly, never by prefix', async () => {
    for (const origin of [
      'http://localhost:30011',
      'http://localhost:3001.example.com',
      'http://localhost.example.com:3001',
      'https://localhost:3001',
      'http://localhost',
    ]) {
      assert.equal(isSameOrigin(origin), false, origin)
      const response = await POST(requestWith({ origin }))
      assert.equal(response.status, 403, origin)
    }
  })

  it('rejects a request without an Origin header with 403', async () => {
    const response = await POST(requestWith({ contentType: null }))
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'forbidden' })
  })

  it('rejects a foreign Origin with 403 and no session work', async () => {
    const response = await POST(requestWith({ origin: 'http://localhost:3002' }))
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'forbidden' })
  })

  it('rejects a non-JSON content type with 415', async () => {
    const response = await POST(requestWith({ origin: 'http://localhost:3001', contentType: 'text/plain' }))
    assert.equal(response.status, 415)
    assert.deepEqual(await response.json(), { error: 'unsupported_media_type' })
  })

  it('accepts the app origin with application/json (charset allowed) and completes the sign-out', async () => {
    const response = await POST(
      requestWith({ origin: 'http://localhost:3001', contentType: 'application/json;charset=utf-8' }),
    )
    // No database is configured under test, so verification resolves to
    // "no session" — exactly what the existing client treats as success.
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    const cookies = response.headers.getSetCookie()
    assert.equal(cookies.length, 3, 'the normal success response expires all session cookies')
  })

  it('fails closed in production when no app origin is configured', async () => {
    const env = process.env as Record<string, string | undefined>
    const savedNodeEnv = env.NODE_ENV
    const savedAppUrl = env.BETTER_AUTH_URL
    env.NODE_ENV = 'production'
    delete env.BETTER_AUTH_URL
    try {
      const response = await POST(requestWith({ origin: 'http://localhost:3001' }))
      assert.equal(response.status, 403, 'production with no configured origin must not fall back to localhost')
    } finally {
      env.NODE_ENV = savedNodeEnv
      if (savedAppUrl !== undefined) env.BETTER_AUTH_URL = savedAppUrl
      else delete env.BETTER_AUTH_URL
    }
  })

  it('expires the session cookies with Path=/ on the success path', async () => {
    const cookies = (await POST(requestWith({ origin: 'http://localhost:3001' }))).headers.getSetCookie()
    for (const cookie of cookies) {
      assert.match(cookie, /Path=\//, `every clear-cookie must be scoped to Path=/ : ${cookie}`)
      assert.match(cookie, /Max-Age=0/, `every clear-cookie must expire: ${cookie}`)
    }
    assert.ok(
      cookies.some((c) => c.startsWith('__Secure-') && c.includes('Secure')),
      'the __Secure- session cookie must carry the Secure flag',
    )
  })
})
