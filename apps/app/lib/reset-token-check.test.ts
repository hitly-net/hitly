import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { emailAndPasswordOptions } from './auth-email-password'
import { RESET_LINK_INVALID_MESSAGE, requestPasswordReset, submitNewPassword } from './password-reset'
import { createRateLimiter, resetCheckClientKey } from './reset-check-limit'
import {
  checkResetToken,
  isWellFormedResetToken,
  loadResetPageState,
  resolveResetPageState,
  type ResetCallbackApi,
  type ResetTokenState,
} from './reset-token-check'

/**
 * The reset page checks the link's token before it shows the form. These tests
 * run the check against the installed Better Auth version on an in-memory
 * adapter, with every Better Auth and console log line captured so we can
 * assert the token never appears in them.
 *
 * Run with: yarn workspace @hitly/app test
 */

const APP_URL = 'http://localhost:3001'

type Sent = { to: string; subject: string; text: string }
let outbox: Sent[] = []
let logLines: string[] = []
let db: Record<string, Record<string, unknown>[]>

function makeAuth() {
  db = { user: [], session: [], account: [], verification: [] }
  return betterAuth({
    database: memoryAdapter(db),
    baseURL: APP_URL,
    secret: 'test-only-secret-at-least-32-characters',
    trustedOrigins: [APP_URL],
    rateLimit: { enabled: false },
    logger: {
      level: 'debug',
      log: (level, message, ...args) => {
        logLines.push([level, message, ...args.map((a) => (a instanceof Error ? a.message : JSON.stringify(a)))].join(' '))
      },
    },
    emailAndPassword: emailAndPasswordOptions(APP_URL, async (message) => {
      outbox.push(message)
      return { delivered: true }
    }),
  })
}

let auth: ReturnType<typeof makeAuth>

/** Inputs that cannot be real reset tokens. */
const MALFORMED_TOKENS = [
  '',
  'abc\u0000def',
  '\u0000',
  'abc\u0001def',
  'abc\u001fdef',
  'abc\u007fdef',
  'abc\ndef',
  'abc def',
  'abc%00def',
  'abc/def',
  'abc?def',
  'abc.def',
  'abc\u00e9def',
  'abc\ud800def',
  'a'.repeat(129),
]

const appFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input), APP_URL)
  const headers = new Headers(init?.headers)
  headers.set('origin', APP_URL)
  return auth.handler(new Request(url, { ...init, headers }))
}

async function tokenFromEmail() {
  await requestPasswordReset('alex@example.com', appFetch)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const match = outbox.at(-1)?.text.match(/https?:\/\/\S+/)
  assert.ok(match, 'reset email must contain a link')
  const token = new URL(match[0]).searchParams.get('token')
  assert.ok(token)
  return token
}

/** Captures console output for the duration of fn. */
async function withConsoleCapture<T>(fn: () => Promise<T>): Promise<T> {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  const saved = methods.map((m) => console[m])
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      logLines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '))
    }
  }
  try {
    return await fn()
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]!))
  }
}

function assertNotLogged(token: string) {
  for (const line of logLines) assert.ok(!line.includes(token), 'a log line contains the reset token')
}

beforeEach(async () => {
  auth = makeAuth()
  outbox = []
  logLines = []
  await auth.api.signUpEmail({ body: { email: 'alex@example.com', password: 'old-password-1', name: 'Alex' } })
})

describe('checking a reset token on page load', () => {
  it('reports a fresh token as valid', async () => {
    const token = await tokenFromEmail()
    assert.equal(await checkResetToken(auth, token), 'valid')
  })

  it('does not use up the token: the check can repeat and the form still works', async () => {
    const token = await tokenFromEmail()
    for (let i = 0; i < 3; i += 1) assert.equal(await checkResetToken(auth, token), 'valid')
    assert.deepEqual(await submitNewPassword(token, 'new-password-2', appFetch), { ok: true })
  })

  it('reports a used token as invalid', async () => {
    const token = await tokenFromEmail()
    assert.deepEqual(await submitNewPassword(token, 'new-password-2', appFetch), { ok: true })
    assert.equal(await checkResetToken(auth, token), 'invalid')
  })

  it('reports an expired token as invalid', async () => {
    const token = await tokenFromEmail()
    const row = db.verification.find((v) => String(v.identifier).endsWith(token))
    assert.ok(row, 'the verification row exists')
    row.expiresAt = new Date(Date.now() - 1000)
    assert.equal(await checkResetToken(auth, token), 'invalid')
  })

  it('reports an unknown token as invalid', async () => {
    assert.equal(await checkResetToken(auth, 'not-a-real-token'), 'invalid')
  })

  it('answers unknown, without logging the error, when the lookup fails', async () => {
    const token = 'token-that-must-not-be-logged'
    const failing = {
      api: {
        requestPasswordResetCallback: async () => {
          throw new Error(`Failed query: select ... params: reset-password:${token}`)
        },
      },
    }
    const state = await withConsoleCapture(() => checkResetToken(failing, token))
    assert.equal(state, 'unknown')
    assert.ok(logLines.length > 0, 'the failure is logged')
    assertNotLogged(token)
  })

  it('answers unknown when the callback reply has no redirect location', async () => {
    const api: ResetCallbackApi = {
      api: { requestPasswordResetCallback: async () => new Response(null, { status: 302 }) },
    }
    assert.equal(await checkResetToken(api, 'abc123'), 'unknown')
  })

  it('answers unknown when the callback redirects with a different token', async () => {
    const api: ResetCallbackApi = {
      api: {
        requestPasswordResetCallback: async () =>
          new Response(null, { status: 302, headers: { location: '/reset-password?token=someOtherToken' } }),
      },
    }
    assert.equal(await checkResetToken(api, 'abc123'), 'unknown')
  })

  it('answers unknown when the callback redirects with no token at all', async () => {
    const api: ResetCallbackApi = {
      api: {
        requestPasswordResetCallback: async () =>
          new Response(null, { status: 302, headers: { location: '/reset-password' } }),
      },
    }
    assert.equal(await checkResetToken(api, 'abc123'), 'unknown')
  })

  it('answers unknown when the callback does not return a response', async () => {
    const api: ResetCallbackApi = { api: { requestPasswordResetCallback: async () => ({ status: true }) } }
    assert.equal(await checkResetToken(api, 'abc123'), 'unknown')
  })

  it('answers invalid for a malformed token without looking it up', async () => {
    let lookups = 0
    const api: ResetCallbackApi = {
      api: {
        requestPasswordResetCallback: async () => {
          lookups += 1
          throw new Error('lookup failed')
        },
      },
    }
    for (const token of MALFORMED_TOKENS) assert.equal(await checkResetToken(api, token), 'invalid')
    assert.equal(lookups, 0)
  })

  it('answers invalid for a malformed token against the real auth instance', async () => {
    for (const token of MALFORMED_TOKENS) assert.equal(await checkResetToken(auth, token), 'invalid')
  })

  it('never logs the token on any path', async () => {
    const token = await tokenFromEmail()
    await withConsoleCapture(async () => {
      await checkResetToken(auth, token)
      await submitNewPassword(token, 'new-password-2', appFetch)
      await checkResetToken(auth, token)
      await submitNewPassword(token, 'new-password-3', appFetch)
      await checkResetToken(auth, 'unknown-token-value')
    })
    assertNotLogged(token)
    assertNotLogged('unknown-token-value')
  })
})

describe('reset token format', () => {
  it('accepts tokens made of letters and digits', async () => {
    assert.equal(isWellFormedResetToken(await tokenFromEmail()), true)
    assert.equal(isWellFormedResetToken('abc'), true)
  })

  it('rejects empty, overlong, non-string and out-of-alphabet tokens', () => {
    for (const token of MALFORMED_TOKENS) assert.equal(isWellFormedResetToken(token), false, JSON.stringify(token))
    assert.equal(isWellFormedResetToken(undefined), false)
    assert.equal(isWellFormedResetToken(['abc']), false)
  })
})

describe('the reset-password callback route', () => {
  it('accepts the relative reset page as callback and redirects with the token', async () => {
    const token = await tokenFromEmail()
    const response = await appFetch(`/api/auth/reset-password/${token}?callbackURL=/reset-password`)
    assert.equal(response.status, 302)
    const location = new URL(response.headers.get('location')!, APP_URL)
    assert.equal(location.origin, APP_URL)
    assert.equal(location.pathname, '/reset-password')
    assert.equal(location.searchParams.get('token'), token)
    assert.deepEqual(await submitNewPassword(token, 'new-password-2', appFetch), { ok: true })
  })

  it('redirects an invalid token to the reset page with error=INVALID_TOKEN', async () => {
    const response = await appFetch('/api/auth/reset-password/not-a-real-token?callbackURL=/reset-password')
    assert.equal(response.status, 302)
    const location = new URL(response.headers.get('location')!, APP_URL)
    assert.equal(location.pathname, '/reset-password')
    assert.equal(location.searchParams.get('error'), 'INVALID_TOKEN')
    assert.equal(location.searchParams.get('token'), null)
  })

  it('refuses a callback on another origin', async () => {
    const token = await tokenFromEmail()
    const response = await appFetch(
      `/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent('https://elsewhere.example/reset-password')}`,
    )
    assert.equal(response.status, 403)
  })
})

describe('choosing what the reset page shows', () => {
  const always = (state: ResetTokenState) => async () => state

  it('shows the form for a valid token', async () => {
    assert.deepEqual(await resolveResetPageState({ token: 'abc' }, always('valid')), { kind: 'form', token: 'abc' })
  })

  it('shows the invalid state for an expired or used token', async () => {
    assert.deepEqual(await resolveResetPageState({ token: 'abc' }, always('invalid')), { kind: 'invalid' })
  })

  it('shows the invalid state when the token is missing or empty', async () => {
    assert.deepEqual(await resolveResetPageState({}, always('valid')), { kind: 'invalid' })
    assert.deepEqual(await resolveResetPageState({ token: '' }, always('valid')), { kind: 'invalid' })
    assert.deepEqual(await resolveResetPageState({ token: ['a', 'b'] }, always('valid')), { kind: 'invalid' })
  })

  it('shows the invalid state for ?error=INVALID_TOKEN, with or without a token', async () => {
    let checked = false
    const check = async () => {
      checked = true
      return 'valid' as const
    }
    assert.deepEqual(await resolveResetPageState({ error: 'INVALID_TOKEN' }, check), { kind: 'invalid' })
    assert.deepEqual(await resolveResetPageState({ error: 'INVALID_TOKEN', token: 'abc' }, check), { kind: 'invalid' })
    assert.equal(checked, false)
  })

  it('shows the invalid state for a malformed token, without checking it, even if the check would fail', async () => {
    let checked = false
    const check = async (): Promise<ResetTokenState> => {
      checked = true
      throw new Error('lookup failed')
    }
    for (const token of MALFORMED_TOKENS) {
      assert.deepEqual(await resolveResetPageState({ token }, check), { kind: 'invalid' }, JSON.stringify(token))
      assert.deepEqual(await resolveResetPageState({ token }, null), { kind: 'invalid' })
    }
    assert.equal(checked, false)
  })

  it('shows the try-again state, never the form, when the check cannot answer', async () => {
    const unavailable = { kind: 'unavailable' }
    assert.deepEqual(await resolveResetPageState({ token: 'abc' }, always('unknown')), unavailable)
    assert.deepEqual(await resolveResetPageState({ token: 'abc' }, null), unavailable)
    const throwing = async (): Promise<ResetTokenState> => {
      throw new Error('lookup failed')
    }
    assert.deepEqual(await resolveResetPageState({ token: 'abc' }, throwing), unavailable)
  })

  it('end to end: a used token from a real email gives the invalid state', async () => {
    const token = await tokenFromEmail()
    const check = (value: string) => checkResetToken(auth, value)
    assert.deepEqual(await resolveResetPageState({ token }, check), { kind: 'form', token })
    assert.deepEqual(await submitNewPassword(token, 'new-password-2', appFetch), { ok: true })
    assert.deepEqual(await resolveResetPageState({ token }, check), { kind: 'invalid' })
    assert.deepEqual(await submitNewPassword(token, 'new-password-3', appFetch), {
      ok: false,
      message: RESET_LINK_INVALID_MESSAGE,
      requestNewLink: true,
    })
  })
})

describe('the reset page wiring', () => {
  const allowAll = () => true

  it('shows the form for a fresh token from a real email', async () => {
    const token = await tokenFromEmail()
    assert.deepEqual(await loadResetPageState({ token }, { auth, clientKey: 'c', allow: allowAll }), {
      kind: 'form',
      token,
    })
  })

  it('shows the invalid state for an unknown or malformed token', async () => {
    const deps = { auth, clientKey: 'c', allow: allowAll }
    assert.deepEqual(await loadResetPageState({ token: 'notARealToken' }, deps), { kind: 'invalid' })
    for (const token of MALFORMED_TOKENS) assert.deepEqual(await loadResetPageState({ token }, deps), { kind: 'invalid' })
  })

  it('shows the try-again state when there is no auth instance', async () => {
    assert.deepEqual(await loadResetPageState({ token: 'abc' }, { auth: null, clientKey: 'c', allow: allowAll }), {
      kind: 'unavailable',
    })
  })

  it('shows the try-again state, and logs no token, when the auth lookup fails', async () => {
    const token = 'tokenThatMustNotBeLogged'
    const failing: ResetCallbackApi = {
      api: {
        requestPasswordResetCallback: async () => {
          throw new Error(`connect failed for reset-password:${token}`)
        },
      },
    }
    const state = await withConsoleCapture(() =>
      loadResetPageState({ token }, { auth: failing, clientKey: 'c', allow: allowAll }),
    )
    assert.deepEqual(state, { kind: 'unavailable' })
    assertNotLogged(token)
  })

  it('shows the try-again state without a lookup once a client is over the limit', async () => {
    const token = await tokenFromEmail()
    const allow = createRateLimiter({ limit: 2, windowMs: 60_000 })
    const deps = { auth, clientKey: 'client-a', allow }
    assert.equal((await loadResetPageState({ token }, deps)).kind, 'form')
    assert.equal((await loadResetPageState({ token }, deps)).kind, 'form')
    assert.deepEqual(await loadResetPageState({ token }, deps), { kind: 'unavailable' })
    assert.equal((await loadResetPageState({ token }, { ...deps, clientKey: 'client-b' })).kind, 'form')
  })

  it('does not count malformed tokens or ?error links against the limit', async () => {
    let calls = 0
    const allow = () => {
      calls += 1
      return true
    }
    await loadResetPageState({ token: 'abc\u0000' }, { auth, clientKey: 'c', allow })
    await loadResetPageState({ error: 'INVALID_TOKEN' }, { auth, clientKey: 'c', allow })
    assert.equal(calls, 0)
  })
})

describe('the reset check limiter', () => {
  it('allows up to the limit per key and window, then resets', () => {
    let time = 0
    const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time })
    assert.equal(allow('a'), true)
    assert.equal(allow('a'), true)
    assert.equal(allow('a'), false)
    assert.equal(allow('b'), true)
    time = 1000
    assert.equal(allow('a'), true)
  })

  it('keeps its key table bounded', () => {
    let time = 0
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3, now: () => time })
    for (const key of ['a', 'b', 'c', 'd', 'e']) assert.equal(allow(key), true)
    time = 5000
    assert.equal(allow('a'), true)
  })

  it('keys clients by the first forwarded address, then the real-ip header', () => {
    assert.equal(resetCheckClientKey(new Headers({ 'x-forwarded-for': '203.0.113.5, 198.51.100.1' })), '203.0.113.5')
    assert.equal(resetCheckClientKey(new Headers({ 'x-real-ip': '203.0.113.7' })), '203.0.113.7')
    assert.equal(resetCheckClientKey(new Headers()), 'unknown')
  })
})

describe('reset page response headers', () => {
  it('sends Referrer-Policy: no-referrer on /reset-password', async () => {
    const configPath = '../next.config.mjs'
    const config = (await import(configPath)) as {
      default: { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }
    }
    const rules = await config.default.headers()
    const rule = rules.find((r) => r.source === '/reset-password')
    assert.ok(rule, 'a header rule exists for the reset page')
    assert.deepEqual(rule.headers, [{ key: 'Referrer-Policy', value: 'no-referrer' }])
  })
})
