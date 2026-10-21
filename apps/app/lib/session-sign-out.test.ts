import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handleSignOut } from '../app/api/session/sign-out/route'

/**
 * Tests for the server-side sign-out route (/api/session/sign-out).
 *
 * Every response must expire all three cookies with the exact attributes the
 * browser needs (the client JS cannot touch the HttpOnly session cookie), and
 * success may only be reported once the session has verifiably ceased to
 * exist. An absent session counts as success (already signed out).
 */

const request = { headers: new Headers({ cookie: 'better-auth.session_token=fake' }) }

// The exact Set-Cookie strings the route must emit.
const EXPECTED_COOKIES = [
  'better-auth.session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=lax',
  '__Secure-better-auth.session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=lax',
  'hitly-workspace-id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; SameSite=lax',
]

function setCookies(response: Response): string[] {
  return (response.headers as Headers).getSetCookie()
}

function expectExactExpiredCookies(response: Response) {
  const cookies = setCookies(response)
  for (const expected of EXPECTED_COOKIES) {
    assert.ok(
      cookies.includes(expected),
      `response must emit the exact cookie "${expected}", got: ${JSON.stringify(cookies)}`,
    )
  }
  assert.equal(cookies.length, EXPECTED_COOKIES.length)
}

const sessionAlive = { user: { id: 'u1' }, session: { id: 's1' } }

describe('session sign-out route', () => {
  it('reports success when the session was revoked and is gone', async () => {
    let revoked = false
    const response = await handleSignOut(request, {
      revoke: async () => {
        revoked = true
      },
      getSession: async () => null,
    })
    assert.equal(revoked, true)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    expectExactExpiredCookies(response)
  })

  it('never reports success when the session still exists after revoke fails', async () => {
    const response = await handleSignOut(request, {
      revoke: async () => {
        throw new Error('revocation failed')
      },
      getSession: async () => sessionAlive,
    })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'sign_out_failed' })
    expectExactExpiredCookies(response)
  })

  it('reports success when revoke throws but the session is gone anyway (already ended)', async () => {
    const response = await handleSignOut(request, {
      revoke: async () => {
        throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 })
      },
      getSession: async () => null,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    expectExactExpiredCookies(response)
  })

  it('never reports success when deletion cannot be verified', async () => {
    const response = await handleSignOut(request, {
      revoke: async () => undefined,
      getSession: async () => {
        throw new Error('database unreachable')
      },
    })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'sign_out_failed' })
    expectExactExpiredCookies(response)
  })

  it('never reports success when the session still exists after a silent revoke', async () => {
    const response = await handleSignOut(request, {
      revoke: async () => undefined,
      getSession: async () => sessionAlive,
    })
    assert.equal(response.status, 500)
    expectExactExpiredCookies(response)
  })

  it('treats an absent session (already signed out, no auth configured) as success', async () => {
    // No deps: falls back to the module auth instance, which is null when no
    // database is configured — the verification then resolves "no session".
    const response = await handleSignOut(request)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    expectExactExpiredCookies(response)
  })
})
