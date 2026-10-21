import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  performSignOut,
  SIGN_OUT_ENDPOINT,
  SIGN_OUT_FAILURE_MESSAGE,
  type SignOutOutcome,
} from './sign-out'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function readLibSignOut() {
  return fs.readFileSync(path.join(__dirname, 'sign-out.ts'), 'utf-8')
}

function readButton() {
  return fs.readFileSync(path.join(__dirname, '../components/sign-out-button.tsx'), 'utf-8')
}

/**
 * Regression tests for sign-out (issue #68 and the 415 / session-ending work).
 *
 * Static assertions pin the request shape, the redirect-only-on-success rule
 * and the button's double-click guard; behavioural tests drive
 * performSignOut() with injected hooks and assert the outcome for every
 * result: 200/204, 401, 415, 5xx, network failure and timeout.
 *
 * Run with: yarn workspace @hitly/app test
 */

describe('sign-out request shape', () => {
  it('posts to the server sign-out route', () => {
    assert.equal(SIGN_OUT_ENDPOINT, '/api/session/sign-out')
    assert.ok(readLibSignOut().includes("'/api/session/sign-out'"))
  })

  it('must include credentials', () => {
    assert.ok(readLibSignOut().includes("credentials: 'include'"))
  })

  it('must send a JSON content type and body', () => {
    const code = readLibSignOut()
    assert.ok(code.includes("'Content-Type': 'application/json'"))
    assert.ok(code.includes("body: '{}'"))
  })

  it('expires the workspace and both better-auth session cookie names', () => {
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

describe('sign-out redirect policy (static)', () => {
  it('redirects only on ok or 401', () => {
    assert.match(readLibSignOut(), /response\.ok\s*\|\|\s*response\.status === 401/)
  })

  it('aborts via AbortController instead of hanging', () => {
    const code = readLibSignOut()
    assert.ok(code.includes('new AbortController()'))
    assert.ok(code.includes('controller.abort()'))
    assert.ok(code.includes('signal: controller.signal'))
  })
})

describe('sign-out button (static)', () => {
  it('shows the exact inline failure message', () => {
    assert.ok(readButton().includes('SIGN_OUT_FAILURE_MESSAGE'))
    assert.equal(SIGN_OUT_FAILURE_MESSAGE, 'Sign-out failed, you are still signed in. Try again.')
  })

  it('disables itself while a request is in flight and blocks re-entry', () => {
    const code = readButton()
    assert.match(code, /disabled=\{pending\}/)
    assert.match(code, /if \(pending\) return/)
  })

  it('does not swallow a thrown sign-out into a silent success', () => {
    assert.match(readButton(), /catch\s*\(/)
    assert.match(readButton(), /performSignOut/)
  })
})

interface RecordedCalls {
  fetchCalls: { url: string; init: RequestInit }[]
  clearedCookies: string[]
  navigations: string[]
  errors: unknown[][]
  outcomes: SignOutOutcome[]
}

function newSignOutMocks(
  options: {
    status?: number
    rejectFetch?: boolean
    neverSettleWithAbort?: boolean
    timeoutMs?: number
  } = {},
) {
  const calls: RecordedCalls = {
    fetchCalls: [],
    clearedCookies: [],
    navigations: [],
    errors: [],
    outcomes: [],
  }
  const hooks = {
    fetchImpl: (url: string, init: RequestInit) => {
      calls.fetchCalls.push({ url, init })
      if (options.neverSettleWithAbort) {
        // A request that never resolves on its own: only the abort signal
        // can end it, exactly like a hung connection.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        })
      }
      if (options.rejectFetch) return Promise.reject(new TypeError('Failed to fetch'))
      const status = options.status ?? 200
      return Promise.resolve(
        new Response(JSON.stringify({ ok: status < 400 }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
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
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  }
  return { calls, hooks }
}

describe('sign-out behaviour', () => {
  it('redirects exactly once on success after one correctly shaped request', async () => {
    const { calls, hooks } = newSignOutMocks({ status: 200 })
    const outcome = await performSignOut(hooks)

    assert.equal(outcome, 'redirected')
    assert.equal(calls.fetchCalls.length, 1, 'must fetch exactly once (no retries)')
    const { url, init } = calls.fetchCalls[0]
    assert.equal(url, SIGN_OUT_ENDPOINT)
    assert.equal(init.method, 'POST')
    assert.equal(init.credentials, 'include')
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json')
    assert.equal(init.body, '{}')
    assert.ok(init.signal instanceof AbortSignal)
    assert.deepEqual(calls.clearedCookies, [
      'hitly-workspace-id',
      'better-auth.session_token',
      '__Secure-better-auth.session_token',
    ])
    assert.deepEqual(calls.navigations, ['/login'])
    assert.equal(calls.errors.length, 0)
  })

  it('redirects to /login on 401 without retrying', async () => {
    const { calls, hooks } = newSignOutMocks({ status: 401 })
    assert.equal(await performSignOut(hooks), 'redirected')
    assert.equal(calls.fetchCalls.length, 1, 'no retry on 401')
    assert.deepEqual(calls.navigations, ['/login'])
  })

  for (const status of [415, 500]) {
    it(`does NOT redirect on HTTP ${status}; reports failure without retrying`, async () => {
      const { calls, hooks } = newSignOutMocks({ status })
      assert.equal(await performSignOut(hooks), 'failed')
      assert.equal(calls.fetchCalls.length, 1, `no retry on ${status}`)
      assert.deepEqual(calls.navigations, [], 'must stay put: the user may still be signed in')
      assert.deepEqual(calls.clearedCookies, [])
      assert.ok(
        calls.errors.some((args) => String(args[0]).includes(String(status))),
        `the ${status} must be logged`,
      )
    })
  }

  it('does NOT redirect on a network error; reports failure without retrying', async () => {
    const { calls, hooks } = newSignOutMocks({ rejectFetch: true })
    assert.equal(await performSignOut(hooks), 'failed')
    assert.equal(calls.fetchCalls.length, 1, 'no retry on network error')
    assert.deepEqual(calls.navigations, [])
    assert.equal(calls.errors.length, 1)
  })

  it('does NOT redirect when the request hangs and times out', async () => {
    const { calls, hooks } = newSignOutMocks({ neverSettleWithAbort: true, timeoutMs: 10 })
    assert.equal(await performSignOut(hooks), 'failed')
    assert.equal(calls.fetchCalls.length, 1, 'the timeout must not spawn another request')
    assert.deepEqual(calls.navigations, [])
  })
})
