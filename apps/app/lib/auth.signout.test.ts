import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performSignOut, SIGN_OUT_ENDPOINT } from './sign-out'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function readLibSignOut() {
  return fs.readFileSync(path.join(__dirname, 'sign-out.ts'), 'utf-8')
}

/**
 * Regression tests for sign-out (issue #68 and the 415 fix).
 *
 * Static assertions keep the request shape and client-state cleanup visible;
 * behavioural tests drive performSignOut() with injected hooks and assert the
 * flow for every outcome: 200, 401, 415, other errors, network failure.
 *
 * Run with: yarn workspace @hitly/app test
 */

describe('sign-out request shape', () => {
  it('posts to the server sign-out route', () => {
    assert.ok(
      readLibSignOut().includes("'/api/session/sign-out'"),
      'sign-out must POST to /api/session/sign-out'
    )
    assert.equal(SIGN_OUT_ENDPOINT, '/api/session/sign-out')
  })

  it('must include credentials', () => {
    assert.ok(
      readLibSignOut().includes("credentials: 'include'"),
      'sign-out fetch must include credentials: "include"'
    )
  })

  it('must send a JSON content type and body', () => {
    const code = readLibSignOut()
    assert.ok(
      code.includes("'Content-Type': 'application/json'"),
      'sign-out fetch must set Content-Type: application/json or the auth router rejects it with 415'
    )
    assert.ok(code.includes("body: '{}'"), "sign-out fetch must send an empty JSON body '{}'")
  })

  it('clears hitly-workspace-id and both better-auth session cookie names', () => {
    const code = readLibSignOut()
    for (const cookie of [
      'hitly-workspace-id',
      'better-auth.session_token',
      '__Secure-better-auth.session_token',
    ]) {
      assert.ok(code.includes(cookie), `sign-out must clear the ${cookie} cookie`)
    }
  })
})

interface RecordedCalls {
  fetchCalls: { url: string; init: RequestInit }[]
  clearedCookies: string[]
  navigations: string[]
  errors: unknown[][]
}

function newSignOutMocks(options: { status?: number; rejectFetch?: boolean } = {}) {
  const calls: RecordedCalls = { fetchCalls: [], clearedCookies: [], navigations: [], errors: [] }
  const hooks = {
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.fetchCalls.push({ url, init })
      if (options.rejectFetch) throw new TypeError('Failed to fetch')
      const status = options.status ?? 200
      return new Response(JSON.stringify({ success: status < 400 }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
    clearBrowserCookie: (name: string) => {
      calls.clearedCookies.push(name)
    },
    navigate: (url: string) => {
      calls.navigations.push(url)
    },
    logError: (...args: unknown[]) => {
      calls.errors.push(args)
    },
  }
  return { calls, hooks }
}

describe('sign-out behaviour', () => {
  it('sends exactly one correctly shaped request on success', async () => {
    const { calls, hooks } = newSignOutMocks()
    await performSignOut(hooks)

    assert.equal(calls.fetchCalls.length, 1, 'must fetch exactly once (no retries)')
    const { url, init } = calls.fetchCalls[0]
    assert.equal(url, SIGN_OUT_ENDPOINT)
    assert.equal(init.method, 'POST')
    assert.equal(init.credentials, 'include')
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json')
    assert.equal(init.body, '{}')

    assert.deepEqual(
      calls.clearedCookies,
      ['hitly-workspace-id', 'better-auth.session_token', '__Secure-better-auth.session_token']
    )
    assert.deepEqual(calls.navigations, ['/login'])
    assert.equal(calls.errors.length, 0)
  })

  for (const status of [401, 415, 500]) {
    it(`redirects to /login exactly once on HTTP ${status}, without retrying`, async () => {
      const { calls, hooks } = newSignOutMocks({ status })
      await performSignOut(hooks)

      assert.equal(calls.fetchCalls.length, 1, `no retry on ${status}`)
      assert.deepEqual(calls.navigations, ['/login'])
      assert.equal(calls.clearedCookies.length, 3)
      assert.ok(
        calls.errors.some((args) => String(args[0]).includes(String(status))),
        `the ${status} must be logged`
      )
    })
  }

  it('redirects to /login on a network error without retrying', async () => {
    const { calls, hooks } = newSignOutMocks({ rejectFetch: true })
    await performSignOut(hooks)

    assert.equal(calls.fetchCalls.length, 1, 'no retry on network error')
    assert.deepEqual(calls.navigations, ['/login'])
    assert.equal(calls.clearedCookies.length, 3)
    assert.equal(calls.errors.length, 1)
  })
})
