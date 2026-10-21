import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { handleSignOut } from '../app/api/session/sign-out/route'

/**
 * Tests for the server-side sign-out route (/api/session/sign-out).
 * Whatever happens to the session revocation call, the response must always
 * expire the HttpOnly session cookies and the workspace cookie.
 */

const request = { headers: new Headers({ cookie: 'better-auth.session_token=fake' }) }

function setCookies(response: Response) {
  const getSetCookie = (response.headers as { getSetCookie?: () => string[] }).getSetCookie
  assert.ok(getSetCookie, 'response must expose set-cookie headers')
  return getSetCookie.call(response.headers)
}

function expectAllCookiesExpired(response: Response) {
  const cookies = setCookies(response)
  for (const name of [
    'better-auth.session_token',
    '__Secure-better-auth.session_token',
    'hitly-workspace-id',
  ]) {
    const cookie = cookies.find((c) => c.startsWith(`${name}=`))
    assert.ok(cookie, `response must expire ${name}`)
    assert.match(cookie, /Max-Age=0/)
    assert.match(cookie, /Path=\//)
  }
  const secureCookie = cookies.find((c) => c.startsWith('__Secure-better-auth.session_token='))!
  assert.match(secureCookie, /Secure/, 'the __Secure- variant must be Secure')
  const plainCookie = cookies.find((c) => c.startsWith('better-auth.session_token='))!
  assert.match(plainCookie, /HttpOnly/, 'the session cookie is HttpOnly')
}

describe('session sign-out route', () => {
  it('revokes the session and expires the cookies on success', async () => {
    let revoked = false
    const response = await handleSignOut(request, {
      revoke: async () => {
        revoked = true
      },
    })
    assert.equal(revoked, true)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    expectAllCookiesExpired(response)
  })

  it('still expires the cookies when revocation throws synchronously', async () => {
    const response = await handleSignOut(request, {
      revoke: () => {
        throw new Error('boom')
      },
    })
    assert.equal(response.status, 200)
    expectAllCookiesExpired(response)
  })

  it('still expires the cookies when revocation rejects (e.g. 401, no session)', async () => {
    const response = await handleSignOut(request, {
      revoke: async () => {
        throw Object.assign(new Error('UNAUTHORIZED'), { status: 401 })
      },
    })
    assert.equal(response.status, 200)
    expectAllCookiesExpired(response)
  })

  it('expires the cookies when there is no session to revoke (no auth configured)', async () => {
    // No revoke dep and no DB-configured auth instance in tests.
    const response = await handleSignOut(request)
    assert.equal(response.status, 200)
    expectAllCookiesExpired(response)
  })
})
