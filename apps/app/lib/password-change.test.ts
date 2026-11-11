import { before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { emailAndPasswordOptions } from './auth-email-password'
import {
  CHANGE_PASSWORD_ATTEMPT_LIMIT,
  createChangePasswordAttemptLimiter,
} from './change-password-limit'
import {
  CHANGE_PASSWORD_ENDPOINT,
  CHANGE_PASSWORD_FAILED_MESSAGE,
  CHANGE_PASSWORD_RETRY_MESSAGE,
  CHANGE_PASSWORD_THROTTLED_MESSAGE,
  CHANGE_PASSWORD_UNAUTHENTICATED_MESSAGE,
  CURRENT_PASSWORD_INCORRECT_MESSAGE,
  submitPasswordChange,
} from './password-change'
import {
  buildPasswordChangedEmail,
  createSendPasswordChangedNotification,
} from './password-change-emails'
import {
  handlePasswordChange,
  type ChangePasswordRouteDeps,
} from './password-change-route'
import {
  MIN_PASSWORD_LENGTH,
  RESET_REQUEST_NETWORK_MESSAGE,
  passwordPolicyMessage,
} from './password-reset'

/**
 * Signed-in password change end to end against the installed Better Auth
 * version, using the app's real email/password options on an in-memory
 * adapter (same harness as lib/password-reset.test.ts): the current password
 * is required, a wrong one changes nothing, other sessions are revoked while
 * the current device continues on the rotated cookie, and the notification
 * email goes through the mocked app mailer.
 *
 * Run with: yarn workspace @hitly/app test
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_URL = 'http://localhost:3001'
const EMAIL = 'alex@example.com'
const OLD_PASSWORD = 'old-password-1'
const NEW_PASSWORD = 'new-password-2'

type Sent = { to: string; subject: string; text: string }
let outbox: Sent[] = []

// Branded emails render on detached fire-and-forget chains; track them so
// assertions drain pending sends deterministically instead of sleeping.
const inflight = new Set<Promise<unknown>>()
function trackMail(chain: Promise<unknown>) {
  inflight.add(chain)
  void chain.finally(() => inflight.delete(chain))
}
async function drainMail() {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight])
  }
}

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
  await drainMail()
}

async function signInCookie(password = OLD_PASSWORD): Promise<string> {
  const response = await post('/api/auth/sign-in/email', { email: EMAIL, password })
  assert.equal(response.status, 200, 'sign-in must succeed')
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

async function sessionUser(cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie, origin: APP_URL }) })
}

function changeRequest(cookie: string | undefined, body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_URL,
    ...extraHeaders,
  }
  if (cookie) headers.cookie = cookie
  return new Request(`${APP_URL}${CHANGE_PASSWORD_ENDPOINT}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function routeMocks(overrides: Partial<ChangePasswordRouteDeps> = {}) {
  const calls = { changePassword: 0, notify: [] as { email: string }[] }
  const deps: ChangePasswordRouteDeps = {
    getSessionUser: async (headers) => {
      const session = await auth.api.getSession({ headers })
      return session?.user ? { id: session.user.id, email: session.user.email } : null
    },
    changePassword: async (headers, body) => {
      calls.changePassword += 1
      return (await auth.api.changePassword({
        headers,
        body: { ...body, revokeOtherSessions: true },
        asResponse: true,
      })) as unknown as Response
    },
    clientKey: () => 'test-client',
    allow: createChangePasswordAttemptLimiter(),
    notify: async ({ email }) => {
      calls.notify.push({ email })
    },
    log: () => {},
    ...overrides,
  }
  return { deps, calls }
}

/** The rotated cookie the handler forwarded, as a Cookie header value. */
function forwardedCookie(response: Response): string {
  const cookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;]+?=)/)
  const pair = cookies.map((cookie) => cookie.trim().split(';')[0]).filter(Boolean)
  assert.ok(
    pair.some((value) => value.startsWith('better-auth.session_token=')),
    `the rotated session cookie must be forwarded, got ${JSON.stringify(pair)}`,
  )
  return pair.join('; ')
}

before(() => {
  auth = makeAuth()
})

beforeEach(async () => {
  await drainMail()
  auth = makeAuth()
  outbox = []
  await auth.api.signUpEmail({ body: { email: EMAIL, password: OLD_PASSWORD, name: 'Alex' } })
})

describe('changing the password while signed in', () => {
  it('succeeds with the correct current password, and the old password stops working', async () => {
    assert.equal(CHANGE_PASSWORD_ENDPOINT, '/api/session/change-password')
    const cookie = await signInCookie()
    const { deps, calls } = routeMocks()
    const response = await handlePasswordChange(
      changeRequest(cookie, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }),
      deps,
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(calls.changePassword, 1)
    assert.deepEqual(calls.notify, [{ email: EMAIL }])

    const signInNew = await post('/api/auth/sign-in/email', { email: EMAIL, password: NEW_PASSWORD })
    assert.equal(signInNew.status, 200)
    const signInOld = await post('/api/auth/sign-in/email', { email: EMAIL, password: OLD_PASSWORD })
    assert.equal(signInOld.status, 401, 'the old password must no longer sign in')
  })

  it('a wrong current password is refused and changes nothing', async () => {
    const cookieA = await signInCookie()
    const cookieB = await signInCookie()
    const { deps, calls } = routeMocks()
    const response = await handlePasswordChange(
      changeRequest(cookieA, { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD }),
      deps,
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { code: 'INVALID_PASSWORD' })
    assert.equal(calls.notify.length, 0, 'a refused attempt sends no email')

    const signInOld = await post('/api/auth/sign-in/email', { email: EMAIL, password: OLD_PASSWORD })
    assert.equal(signInOld.status, 200, 'the password is unchanged')
    assert.ok(await sessionUser(cookieB), 'other sessions are untouched by a refused attempt')

    // The same request with the correct password then succeeds.
    const good = await handlePasswordChange(
      changeRequest(cookieA, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }),
      deps,
    )
    assert.equal(good.status, 200)
  })

  it('a weak new password is refused with the shared policy message', async () => {
    const cookie = await signInCookie()
    const { deps } = routeMocks()
    const response = await handlePasswordChange(
      changeRequest(cookie, { currentPassword: OLD_PASSWORD, newPassword: 'short' }),
      deps,
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { code: 'PASSWORD_TOO_SHORT' })

    const signInOld = await post('/api/auth/sign-in/email', { email: EMAIL, password: OLD_PASSWORD })
    assert.equal(signInOld.status, 200, 'the password is unchanged')

    // The client maps the code through the shared helper, so the reset and
    // change forms word the strength rule identically.
    const weakFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 'PASSWORD_TOO_SHORT' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    const outcome = await submitPasswordChange(OLD_PASSWORD, 'short', weakFetch)
    assert.deepEqual(outcome, { ok: false, message: passwordPolicyMessage('PASSWORD_TOO_SHORT') })
    assert.equal(outcome.ok === false && outcome.message, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  })

  it('revokes other sessions and keeps the current one on the rotated cookie', async () => {
    const cookieA = await signInCookie()
    const cookieB = await signInCookie()
    assert.ok(await sessionUser(cookieA))
    assert.ok(await sessionUser(cookieB))

    const { deps } = routeMocks()
    const response = await handlePasswordChange(
      changeRequest(cookieA, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }),
      deps,
    )
    assert.equal(response.status, 200)
    const rotated = forwardedCookie(response)

    assert.equal(await sessionUser(cookieB), null, 'the other session is revoked')
    const kept = await sessionUser(rotated)
    assert.ok(kept, 'the current device stays signed in on the rotated cookie')
    assert.equal(kept?.user.email, EMAIL)
  })

  it('sends one password-changed email through the mocked mailer, with no secret in it', async () => {
    const cookie = await signInCookie()
    await drainMail()
    outbox = []
    const { deps } = routeMocks({ notify: createSendPasswordChangedNotification(async (message) => {
      outbox.push(message)
      return { delivered: true }
    }, { track: trackMail }) })
    const response = await handlePasswordChange(
      changeRequest(cookie, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }),
      deps,
    )
    assert.equal(response.status, 200)
    await settle()

    assert.equal(outbox.length, 1)
    const mail = outbox[0]!
    assert.equal(mail.to, EMAIL)
    assert.match(mail.subject, /password/i)
    assert.match(mail.text, /password/i)
    // No secret, token or link of any kind.
    assert.ok(!mail.text.includes(OLD_PASSWORD) && !mail.text.includes(NEW_PASSWORD), 'no password in the email')
    assert.ok(!/token/i.test(mail.text), 'no token wording in the email')
    assert.ok(!/https?:\/\//.test(mail.text), 'no link in the email')
    assert.deepEqual(await buildPasswordChangedEmail({ to: EMAIL }), mail, 'the handler used the shared builder')
  })
})

describe('password change request policy', () => {
  it('rejects an unauthenticated request with 401 and never runs the change', async () => {
    const { deps, calls } = routeMocks()
    const response = await handlePasswordChange(
      changeRequest(undefined, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }),
      deps,
    )
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
    assert.equal(calls.changePassword, 0)
  })

  it('rejects a request missing either password with 400 and never runs the change', async () => {
    const cookie = await signInCookie()
    for (const body of [{ newPassword: NEW_PASSWORD }, { currentPassword: OLD_PASSWORD }, {}]) {
      const { deps, calls } = routeMocks()
      const response = await handlePasswordChange(changeRequest(cookie, body), deps)
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal(calls.changePassword, 0)
    }
  })

  it('throttles wrong-password attempts per client and then answers 429', async () => {
    const cookie = await signInCookie()
    const shared = createChangePasswordAttemptLimiter()
    const { deps, calls } = routeMocks({
      clientKey: (headers) => headers.get('x-client') ?? 'anon',
      allow: shared,
    })

    for (let attempt = 0; attempt < CHANGE_PASSWORD_ATTEMPT_LIMIT; attempt += 1) {
      const response = await handlePasswordChange(
        changeRequest(cookie, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }, { 'x-client': 'a' }),
        deps,
      )
      assert.equal(response.status, 400, `attempt ${attempt}`)
    }
    const blocked = await handlePasswordChange(
      changeRequest(cookie, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }, { 'x-client': 'a' }),
      deps,
    )
    assert.equal(blocked.status, 429)
    assert.deepEqual(await blocked.json(), { error: 'too_many_attempts' })
    assert.equal(calls.changePassword, CHANGE_PASSWORD_ATTEMPT_LIMIT, 'the blocked attempt never checks the password')

    // A different client is unaffected by client a's spent budget.
    const other = await handlePasswordChange(
      changeRequest(cookie, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }, { 'x-client': 'b' }),
      deps,
    )
    assert.equal(other.status, 400, 'the limit is per client')
  })

  it('the route refuses cross-site and non-JSON requests before any session work', async () => {
    const { POST } = await import('../app/api/session/change-password/route')
    const headers = { origin: 'http://localhost:3002', 'content-type': 'application/json' }
    const crossSite = new NextRequest(`${APP_URL}${CHANGE_PASSWORD_ENDPOINT}`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assert.equal((await POST(crossSite)).status, 403)

    const wrongType = new NextRequest(`${APP_URL}${CHANGE_PASSWORD_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3001', 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal((await POST(wrongType)).status, 415)
  })
})

describe('submitPasswordChange outcome mapping', () => {
  const fake = (status: number, body: unknown): typeof fetch => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('maps every server answer to a fixed message', async () => {
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, fake(200, { ok: true })), { ok: true })
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, fake(401, {})), {
      ok: false,
      message: CHANGE_PASSWORD_UNAUTHENTICATED_MESSAGE,
    })
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, fake(429, {})), {
      ok: false,
      message: CHANGE_PASSWORD_THROTTLED_MESSAGE,
    })
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, fake(500, {})), {
      ok: false,
      message: CHANGE_PASSWORD_RETRY_MESSAGE,
    })
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, fake(400, { code: 'INVALID_PASSWORD' })), {
      ok: false,
      message: CURRENT_PASSWORD_INCORRECT_MESSAGE,
    })
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, fake(400, { code: 'PASSWORD_TOO_LONG' })), {
      ok: false,
      message: passwordPolicyMessage('PASSWORD_TOO_LONG'),
    })
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, fake(400, { code: 'WHATEVER' })), {
      ok: false,
      message: CHANGE_PASSWORD_FAILED_MESSAGE,
    })
    const offline: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    assert.deepEqual(await submitPasswordChange(OLD_PASSWORD, NEW_PASSWORD, offline), {
      ok: false,
      message: RESET_REQUEST_NETWORK_MESSAGE,
    })
  })
})

describe('shared strength rules (static)', () => {
  it('the change flow never redefines the policy wording', () => {
    for (const file of ['password-change.ts', 'password-change-route.ts']) {
      const code = fs.readFileSync(path.join(__dirname, file), 'utf-8')
      if (file === 'password-change.ts') {
        assert.ok(code.includes('passwordPolicyMessage'), 'the change flow imports the shared helper')
      }
      assert.ok(!code.includes('Use at least'), `the policy wording is not copied into ${file}`)
    }
  })

  it('the security page renders the change form, which pins the shared minimum length', () => {
    const page = fs.readFileSync(path.join(__dirname, '../app/settings/security/page.tsx'), 'utf-8')
    assert.ok(page.includes('<ChangePasswordForm'))
    const form = fs.readFileSync(path.join(__dirname, '../components/change-password-form.tsx'), 'utf-8')
    assert.ok(form.includes('name="currentPassword"'), 'the current password is required')
    assert.ok(form.includes('minLength={MIN_PASSWORD_LENGTH}'), 'the same minimum length as reset')
    assert.ok(form.includes('PASSWORD_MISMATCH_MESSAGE'), 'the same mismatch message as reset')
  })
})
