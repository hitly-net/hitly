import { before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { emailAndPasswordOptions } from './auth-email-password'
import {
  INVALID_EMAIL_MESSAGE,
  REQUEST_PASSWORD_RESET_ENDPOINT,
  RESET_LINK_INVALID_MESSAGE,
  RESET_PASSWORD_ENDPOINT,
  RESET_REQUESTED_MESSAGE,
  requestPasswordReset,
  submitNewPassword,
} from './password-reset'

/**
 * Password reset end to end against the installed Better Auth version, using
 * the app's real email/password options on an in-memory adapter.
 *
 * Run with: yarn workspace @hitly/app test
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_URL = 'http://localhost:3001'

type Sent = { to: string; subject: string; text: string }
let outbox: Sent[] = []

function makeAuth() {
  const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] }
  return betterAuth({
    database: memoryAdapter(db),
    baseURL: APP_URL,
    secret: 'test-only-secret-at-least-32-characters',
    trustedOrigins: [APP_URL],
    rateLimit: { enabled: false },
    logger: { disabled: true },
    emailAndPassword: emailAndPasswordOptions(APP_URL, async (message) => {
      outbox.push(message)
      return { delivered: true }
    }),
  })
}

let auth: ReturnType<typeof makeAuth>

/** Routes a browser-style fetch at the in-process Better Auth handler. */
const appFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input), APP_URL)
  const headers = new Headers(init?.headers)
  headers.set('origin', APP_URL)
  return auth.handler(new Request(url, { ...init, headers }))
}

function post(pathname: string, body: unknown) {
  return appFetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

function linkFrom(mail: Sent) {
  const match = mail.text.match(/https?:\/\/\S+/)
  assert.ok(match, 'reset email must contain a link')
  return new URL(match[0])
}

before(() => {
  auth = makeAuth()
})

beforeEach(async () => {
  auth = makeAuth()
  outbox = []
  await auth.api.signUpEmail({ body: { email: 'alex@example.com', password: 'old-password-1', name: 'Alex' } })
})

describe('reset route paths', () => {
  it('the client posts to the mounted request-password-reset route', async () => {
    assert.equal(REQUEST_PASSWORD_RESET_ENDPOINT, '/api/auth/request-password-reset')
    const response = await post(REQUEST_PASSWORD_RESET_ENDPOINT, { email: 'alex@example.com' })
    assert.equal(response.status, 200)
  })

  it('the old forget-password path is not served by this Better Auth version', async () => {
    const response = await post('/api/auth/forget-password', { email: 'alex@example.com' })
    assert.equal(response.status, 404)
  })

  it('an unknown auth path returns 404', async () => {
    const response = await post('/api/auth/no-such-route', {})
    assert.equal(response.status, 404)
  })

  it('no page or component still calls the old path', () => {
    for (const file of [
      '../app/forgot-password/page.tsx',
      '../components/forgot-password-form.tsx',
      '../components/auth-form.tsx',
      './password-reset.ts',
    ]) {
      const code = fs.readFileSync(path.join(__dirname, file), 'utf-8')
      assert.ok(!code.includes("'/api/auth/forget-password'"), `${file} must not call /api/auth/forget-password`)
    }
  })
})

describe('requesting a reset', () => {
  it('sends one email with a link to the reset page', async () => {
    const outcome = await requestPasswordReset('alex@example.com', appFetch)
    await settle()
    assert.deepEqual(outcome, { kind: 'sent', message: RESET_REQUESTED_MESSAGE })
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0]?.to, 'alex@example.com')
    const link = linkFrom(outbox[0]!)
    assert.equal(link.origin, APP_URL)
    assert.equal(link.pathname, '/reset-password')
    assert.ok(link.searchParams.get('token'))
  })

  it('answers an unknown email with the same message and sends nothing', async () => {
    const known = await post(REQUEST_PASSWORD_RESET_ENDPOINT, { email: 'alex@example.com' })
    const unknown = await post(REQUEST_PASSWORD_RESET_ENDPOINT, { email: 'nobody@example.com' })
    assert.equal(unknown.status, known.status)
    assert.deepEqual(await unknown.json(), await known.json())
    outbox = []
    const outcome = await requestPasswordReset('nobody@example.com', appFetch)
    await settle()
    assert.deepEqual(outcome, { kind: 'sent', message: RESET_REQUESTED_MESSAGE })
    assert.equal(outbox.length, 0)
  })

  it('shows the neutral message for server errors too', async () => {
    for (const status of [404, 500, 503]) {
      const fake: typeof fetch = async () => new Response('{}', { status })
      assert.deepEqual(await requestPasswordReset('alex@example.com', fake), {
        kind: 'sent',
        message: RESET_REQUESTED_MESSAGE,
      })
    }
  })

  it('reports a malformed email as a validation error', async () => {
    const outcome = await requestPasswordReset('not-an-email', appFetch)
    assert.deepEqual(outcome, { kind: 'invalid-email', message: INVALID_EMAIL_MESSAGE })
  })

  it('reports a network failure without mentioning the account', async () => {
    const offline: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const outcome = await requestPasswordReset('alex@example.com', offline)
    assert.equal(outcome.kind, 'network')
  })
})

describe('setting a new password', () => {
  async function tokenFromEmail() {
    await requestPasswordReset('alex@example.com', appFetch)
    await settle()
    return linkFrom(outbox[0]!).searchParams.get('token')!
  }

  it('the reset page form sets the new password and the old one stops working', async () => {
    assert.equal(RESET_PASSWORD_ENDPOINT, '/api/auth/reset-password')
    const token = await tokenFromEmail()
    assert.deepEqual(await submitNewPassword(token, 'new-password-2', appFetch), { ok: true })

    const signInNew = await post('/api/auth/sign-in/email', { email: 'alex@example.com', password: 'new-password-2' })
    assert.equal(signInNew.status, 200)
    const signInOld = await post('/api/auth/sign-in/email', { email: 'alex@example.com', password: 'old-password-1' })
    assert.equal(signInOld.status, 401)
  })

  it('a token works once', async () => {
    const token = await tokenFromEmail()
    assert.deepEqual(await submitNewPassword(token, 'new-password-2', appFetch), { ok: true })
    assert.deepEqual(await submitNewPassword(token, 'new-password-3', appFetch), {
      ok: false,
      message: RESET_LINK_INVALID_MESSAGE,
    })
  })

  it('rejects an unknown token', async () => {
    assert.deepEqual(await submitNewPassword('not-a-token', 'new-password-2', appFetch), {
      ok: false,
      message: RESET_LINK_INVALID_MESSAGE,
    })
  })

  it('the reset page reads the token from the link', () => {
    const page = fs.readFileSync(path.join(__dirname, '../app/reset-password/page.tsx'), 'utf-8')
    assert.ok(page.includes('params.token'))
    const form = fs.readFileSync(path.join(__dirname, '../components/reset-password-form.tsx'), 'utf-8')
    assert.ok(form.includes('submitNewPassword'))
    assert.ok(form.includes('name="newPassword"'))
  })
})
