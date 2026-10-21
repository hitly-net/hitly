import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  performSignOut,
  SIGN_OUT_ENDPOINT,
  SIGN_OUT_FAILURE_MESSAGE,
  SIGN_OUT_SERVER_ERROR_CODE,
  SIGN_OUT_SERVER_FAILURE_MESSAGE,
  SIGN_OUT_TIMEOUT_MS,
  signOutFailureMessage,
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
  it('shows the exact inline failure messages through the outcome mapping', () => {
    assert.ok(readButton().includes('signOutFailureMessage'))
    assert.equal(SIGN_OUT_FAILURE_MESSAGE, 'Sign-out failed, you are still signed in. Try again.')
    assert.equal(
      SIGN_OUT_SERVER_FAILURE_MESSAGE,
      'Signed out on this device, but we could not end your session on the server. Try again.',
    )
    assert.equal(signOutFailureMessage('failed'), SIGN_OUT_FAILURE_MESSAGE)
    assert.equal(signOutFailureMessage('failed_server'), SIGN_OUT_SERVER_FAILURE_MESSAGE)
  })

  it('never shows raw error text: every message comes from the outcome mapping', async () => {
    const code = readButton()
    const setFailureArgs = [...code.matchAll(/setFailure\(([^)]*\)?)\)/g)].map((m) => m[1].trim())
    assert.ok(setFailureArgs.length >= 2, 'expected the failure and catch paths')
    for (const arg of setFailureArgs) {
      assert.ok(
        arg === 'null' || /^signOutFailureMessage\((outcome|'failed')\)$/.test(arg),
        `setFailure must only receive null or signOutFailureMessage(...), got: ${arg}`,
      )
    }
    assert.ok(!/\{\s*(error|err|e)(\.message)?\s*\}/.test(code), 'no error object is rendered')
    assert.match(code, /\{failure\}/)

    // Whatever the server or network says, the message is one of the two fixed strings.
    const allowed = new Set([SIGN_OUT_FAILURE_MESSAGE, SIGN_OUT_SERVER_FAILURE_MESSAGE])
    const raw = 'raw server detail: stack trace at line 42'
    for (const options of [
      { status: 500, body: JSON.stringify({ error: raw }) },
      { status: 500, body: JSON.stringify({ error: 'sign_out_failed', message: raw }) },
      { status: 403, body: JSON.stringify({ error: raw }) },
      { status: 500, body: raw, contentType: 'text/plain' },
      { rejectFetch: true },
    ]) {
      const { hooks } = newSignOutMocks(options)
      const outcome = await performSignOut(hooks)
      assert.notEqual(outcome, 'redirected')
      const message = signOutFailureMessage(outcome as Exclude<SignOutOutcome, 'redirected'>)
      assert.ok(allowed.has(message), message)
      assert.ok(!message.includes(raw))
    }
    for (const unexpected of ['boom', '', undefined]) {
      const message = signOutFailureMessage(unexpected as unknown as 'failed')
      assert.equal(message, SIGN_OUT_FAILURE_MESSAGE, 'unknown outcomes fall back to the fixed message')
    }
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
    /** Raw response body; defaults to {"ok": status < 400}. */
    body?: string
    contentType?: string
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
        new Response(options.body ?? JSON.stringify({ ok: status < 400 }), {
          status,
          headers: { 'content-type': options.contentType ?? 'application/json' },
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

  it('does NOT redirect on HTTP 415; reports failure without retrying', async () => {
    const { calls, hooks } = newSignOutMocks({ status: 415 })
    assert.equal(await performSignOut(hooks), 'failed')
    assert.equal(calls.fetchCalls.length, 1, 'no retry on 415')
    assert.deepEqual(calls.navigations, [], 'must stay put: the user may still be signed in')
    assert.deepEqual(calls.clearedCookies, [])
    assert.ok(calls.errors.some((args) => String(args[0]).includes('415')), 'the 415 must be logged')
  })

  it("on the route's own 500 (error 'sign_out_failed') reports failed_server", async () => {
    assert.equal(SIGN_OUT_SERVER_ERROR_CODE, 'sign_out_failed')
    const { calls, hooks } = newSignOutMocks({ status: 500, body: JSON.stringify({ error: 'sign_out_failed' }) })
    const outcome = await performSignOut(hooks)
    assert.equal(outcome, 'failed_server')
    assert.equal(calls.fetchCalls.length, 1, 'no retry on 500')
    assert.deepEqual(calls.navigations, [], 'must stay put: ask the user to retry')
    assert.deepEqual(calls.clearedCookies, [], 'the server already expired the cookies on its response')
    assert.equal(signOutFailureMessage(outcome), SIGN_OUT_SERVER_FAILURE_MESSAGE)
    assert.ok(calls.errors.some((args) => String(args[0]).includes('500')), 'the 500 must be logged')
  })

  it('treats any other HTTP 500 as a plain failure (still signed in)', async () => {
    const bodies: Array<{ body: string; contentType?: string }> = [
      { body: JSON.stringify({ ok: false }) },
      { body: JSON.stringify({ error: 'internal_error' }) },
      { body: JSON.stringify({ error: 'SIGN_OUT_FAILED' }) },
      { body: JSON.stringify({ error: { code: 'sign_out_failed' } }) },
      { body: JSON.stringify('sign_out_failed') },
      { body: '' },
      { body: '<!DOCTYPE html><html><body>Internal Server Error</body></html>', contentType: 'text/html' },
    ]
    for (const { body, contentType } of bodies) {
      const { calls, hooks } = newSignOutMocks({ status: 500, body, contentType })
      const outcome = await performSignOut(hooks)
      assert.equal(outcome, 'failed', `500 with body ${body}`)
      assert.equal(signOutFailureMessage(outcome), SIGN_OUT_FAILURE_MESSAGE)
      assert.equal(calls.fetchCalls.length, 1, 'no retry')
      assert.deepEqual(calls.navigations, [])
    }
  })

  it("does not treat 'sign_out_failed' on a non-500 status as failed_server", async () => {
    for (const status of [400, 403, 502, 503]) {
      const { hooks } = newSignOutMocks({ status, body: JSON.stringify({ error: 'sign_out_failed' }) })
      assert.equal(await performSignOut(hooks), 'failed', String(status))
    }
  })

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

describe('sign-out timeout handling', () => {
  it('uses the exported 10 second timeout value and always calls clearTimeout', async () => {
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    const started: number[] = []
    let cleared = 0
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      started.push(ms ?? 0)
      return realSet(fn, ms)
    }) as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      cleared += 1
      return realClear(id)
    }) as typeof globalThis.clearTimeout
    try {
      assert.equal(SIGN_OUT_TIMEOUT_MS, 10_000, 'the client timeout is 10 seconds')

      const done = newSignOutMocks({ status: 200 })
      assert.equal(await performSignOut(done.hooks), 'redirected')
      assert.ok(
        started.some((ms) => ms === SIGN_OUT_TIMEOUT_MS),
        `the timer must be armed with SIGN_OUT_TIMEOUT_MS (${SIGN_OUT_TIMEOUT_MS}), got ${JSON.stringify(started)}`,
      )
      assert.ok(cleared >= 1, 'clearTimeout must run when the request settles')

      const hang = newSignOutMocks({ neverSettleWithAbort: true, timeoutMs: 5 })
      assert.equal(await performSignOut(hang.hooks), 'failed')
      assert.ok(cleared >= 2, 'clearTimeout must run after the timeout fires too')
    } finally {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  })
})

describe('client cookie expiry (default clearBrowserCookie)', () => {
  it('writes the exact clear-cookie strings: Path=/ everywhere, Secure on the __Secure- cookie', async () => {
    const written: string[] = []
    const previousDocument = (globalThis as Record<string, unknown>).document
    ;(globalThis as Record<string, unknown>).document = {
      set cookie(value: string) {
        written.push(value)
      },
      get cookie() {
        return ''
      },
    }
    try {
      const { hooks } = newSignOutMocks({ status: 200 })
      delete (hooks as Record<string, unknown>).clearBrowserCookie
      assert.equal(await performSignOut(hooks), 'redirected')
    } finally {
      ;(globalThis as Record<string, unknown>).document = previousDocument
    }
    assert.deepEqual(written, [
      'hitly-workspace-id=; Path=/; Max-Age=0; SameSite=Lax',
      'better-auth.session_token=; Path=/; Max-Age=0; SameSite=Lax',
      '__Secure-better-auth.session_token=; Path=/; Max-Age=0; SameSite=Lax; Secure',
    ])
  })
})
