import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { emailAndPasswordOptions } from './auth-email-password'
import { RESET_LINK_INVALID_MESSAGE, requestPasswordReset, submitNewPassword } from './password-reset'
import { checkResetToken, resolveResetPageToken, type ResetTokenState } from './reset-token-check'

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
    assert.equal(await resolveResetPageToken({ token: 'abc' }, always('valid')), 'abc')
  })

  it('shows the invalid state for an expired or used token', async () => {
    assert.equal(await resolveResetPageToken({ token: 'abc' }, always('invalid')), null)
  })

  it('shows the invalid state when the token is missing or empty', async () => {
    assert.equal(await resolveResetPageToken({}, always('valid')), null)
    assert.equal(await resolveResetPageToken({ token: '' }, always('valid')), null)
    assert.equal(await resolveResetPageToken({ token: ['a', 'b'] }, always('valid')), null)
  })

  it('shows the invalid state for ?error=INVALID_TOKEN, with or without a token', async () => {
    let checked = false
    const check = async () => {
      checked = true
      return 'valid' as const
    }
    assert.equal(await resolveResetPageToken({ error: 'INVALID_TOKEN' }, check), null)
    assert.equal(await resolveResetPageToken({ error: 'INVALID_TOKEN', token: 'abc' }, check), null)
    assert.equal(checked, false)
  })

  it('falls back to the form when the check cannot answer', async () => {
    assert.equal(await resolveResetPageToken({ token: 'abc' }, always('unknown')), 'abc')
    assert.equal(await resolveResetPageToken({ token: 'abc' }, null), 'abc')
  })

  it('end to end: a used token from a real email gives the invalid state', async () => {
    const token = await tokenFromEmail()
    const check = (value: string) => checkResetToken(auth, value)
    assert.equal(await resolveResetPageToken({ token }, check), token)
    assert.deepEqual(await submitNewPassword(token, 'new-password-2', appFetch), { ok: true })
    assert.equal(await resolveResetPageToken({ token }, check), null)
    assert.deepEqual(await submitNewPassword(token, 'new-password-3', appFetch), {
      ok: false,
      message: RESET_LINK_INVALID_MESSAGE,
      requestNewLink: true,
    })
  })
})
