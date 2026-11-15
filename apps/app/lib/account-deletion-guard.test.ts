/**
 * Guard tests for the deletion surface's entry points.
 *
 * The raw Better Auth `POST /delete-user` would delete the `users` row with
 * none of the account-deletion rulings applied, so it must be unreachable over
 * HTTP; these tests pin the path matcher AND the catch-all wiring (a matcher
 * that stops matching, or a catch-all that forgets to consult it, fails here).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRawAccountDeletePath, RAW_ACCOUNT_DELETE_PATHS } from './account-deletion'
import { handleAuthRequest } from '../app/api/auth/[...all]/route'

const APP = 'http://localhost:3001'

describe('raw account-delete path matcher', () => {
  it('matches the Better Auth delete-user endpoint', () => {
    for (const path of RAW_ACCOUNT_DELETE_PATHS) {
      assert.equal(isRawAccountDeletePath(`${APP}/api/auth${path}`), true, path)
      assert.equal(isRawAccountDeletePath(`${APP}/api/auth${path}/`), true, `${path}/`)
      assert.equal(isRawAccountDeletePath(`${APP}/api/auth${path.toUpperCase()}`), true, path)
    }
  })

  it('does not match the HITLy deletion flow or unrelated auth paths', () => {
    const safe = [
      '/api/session/delete-account',
      '/api/session/delete-account/preview',
      '/api/session/delete-account/reauth',
      '/api/session/delete-account/reauth/options',
      '/api/session/export',
      '/api/auth/sign-in/email',
      '/api/auth/passkey/verify-authentication',
      '/api/auth/get-session',
      '/settings/account',
    ]
    for (const path of safe) {
      assert.equal(isRawAccountDeletePath(`${APP}${path}`), false, path)
    }
  })

  it('fails closed on a value that is not a URL', () => {
    assert.equal(isRawAccountDeletePath('delete-user'), false)
    assert.equal(isRawAccountDeletePath(''), false)
  })
})

describe('auth catch-all refuses the raw delete endpoint', () => {
  async function runAgainst(url: string, method = 'POST') {
    const calls: string[] = []
    const response = await handleAuthRequest(
      new Request(url, { method }),
      async (request) => {
        calls.push(request.url)
        return new Response(JSON.stringify({ reached: true }), { status: 200 })
      },
    )
    return { status: response.status, calls }
  }

  it('404s /api/auth/delete-user without reaching the handler', async () => {
    const { status, calls } = await runAgainst(`${APP}/api/auth/delete-user`)
    assert.equal(status, 404)
    assert.deepEqual(calls, [], 'the stock handler must never run for delete-user')
  })

  it('still passes unrelated endpoints through', async () => {
    const { status, calls } = await runAgainst(`${APP}/api/auth/get-session`, 'GET')
    assert.equal(status, 200)
    assert.equal(calls.length, 1)
  })
})
