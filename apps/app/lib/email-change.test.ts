/**
 * Signed-in email change against real Postgres and the app's real Better Auth
 * instance: pending storage (hash only), old email stays live until confirm,
 * single use, expiry, replacement, no enumeration, notice to the previous
 * address, and no token in logs.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'
process.env.HITLY_SIGNUP_ENABLED = '1'

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { and, eq, inArray, like } from 'drizzle-orm'
import { accounts, memberships, pendingEmailChanges, sessions, users, workspaces } from '@hitly/db/schema'
import { clearSentMail, sentMail } from '@hitly/mail'
import { auth } from './auth'
import { db, pool } from './db'
import {
  CHANGE_EMAIL_ENDPOINT,
  CHANGE_EMAIL_FAILED_MESSAGE,
  CHANGE_EMAIL_RETRY_MESSAGE,
  CHANGE_EMAIL_THROTTLED_MESSAGE,
  CHANGE_EMAIL_UNAUTHENTICATED_MESSAGE,
  CURRENT_PASSWORD_INCORRECT_MESSAGE,
  EMAIL_CHANGE_TTL_MS,
  INVALID_EMAIL_MESSAGE,
  VERIFY_EMAIL_CHANGE_ENDPOINT,
  VERIFY_EMAIL_CHANGE_INVALID_MESSAGE,
  VERIFY_EMAIL_CHANGE_PAGE,
  buildEmailChangePageUrl,
  buildEmailChangeVerificationEmail,
  buildEmailChangedNotice,
  createSendEmailChangeVerification,
  createSendEmailChangedNotice,
  submitEmailChange,
  submitEmailChangeVerification,
} from './email-change'
import {
  EMAIL_CHANGE_ATTEMPT_LIMIT,
  createEmailChangeAttemptLimiter,
} from './email-change-limit'
import {
  generateEmailChangeToken,
  handleEmailChange,
  handleEmailChangeVerify,
  hashEmailChangeToken,
  type EmailChangeRouteDeps,
} from './email-change-route'
import { PUBLIC_PATHS } from './constants'
import { newId } from './ids'
import { RESET_REQUEST_NETWORK_MESSAGE } from './password-reset'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `email-change-${run}.example.com`
const PASSWORD = 'correct-horse-battery'

const logged: string[] = []
const tokensSeen: string[] = []
const restore: Array<() => void> = []

function capture() {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level]
    console[level] = (...args: unknown[]) => {
      logged.push(
        args
          .map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' '),
      )
    }
    restore.push(() => {
      console[level] = original
    })
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream)
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk))
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof stream.write
    restore.push(() => {
      stream.write = original
    })
  }
}

function email(local: string) {
  return `${local}@${emailDomain}`
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

async function createUser(address: string, name = 'Alex') {
  await authApi.signUpEmail({ body: { email: address, name, password: PASSWORD } })
}

async function signInCookie(address: string, password = PASSWORD) {
  const { headers } = await authApi.signInEmail({
    body: { email: address, password },
    returnHeaders: true,
  })
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

async function signInStatus(address: string, password = PASSWORD) {
  try {
    const response = (await authApi.signInEmail({
      body: { email: address, password },
      asResponse: true,
    })) as unknown as Response
    return response.status
  } catch {
    return 401
  }
}

async function userByEmail(address: string) {
  const rows = await database
    .select()
    .from(users)
    .where(eq(users.email, address.toLowerCase()))
    .limit(1)
  return rows[0] ?? null
}

async function pendingFor(userId: string) {
  const rows = await database
    .select()
    .from(pendingEmailChanges)
    .where(eq(pendingEmailChanges.userId, userId))
    .limit(1)
  return rows[0] ?? null
}

function changeRequest(cookie: string | undefined, body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_URL,
    ...extraHeaders,
  }
  if (cookie) headers.cookie = cookie
  return new Request(`${APP_URL}${CHANGE_EMAIL_ENDPOINT}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function routeMocks(overrides: Partial<EmailChangeRouteDeps> = {}): EmailChangeRouteDeps {
  return {
    log: () => {},
    ...overrides,
  }
}

function tokenFrom(mail: { text: string }) {
  const match = mail.text.match(/[?&]token=([A-Za-z0-9_-]{43})/)
  assert.ok(match, 'confirmation email must contain the token')
  tokensSeen.push(match[1]!)
  return match[1]!
}

async function startPendingChange(localOld: string, localNew: string, deps: EmailChangeRouteDeps = {}) {
  const oldAddress = email(localOld)
  const newAddress = email(localNew)
  await createUser(oldAddress)
  const cookie = await signInCookie(oldAddress)
  clearSentMail()
  const response = await handleEmailChange(
    changeRequest(cookie, { currentPassword: PASSWORD, newEmail: newAddress }),
    { ...routeMocks(), allow: () => true, ...deps },
  )
  assert.equal(response.status, 200)
  await settle()
  const token = tokenFrom(sentMail[0]!)
  const user = await userByEmail(oldAddress)
  assert.ok(user)
  return { oldAddress, newAddress, cookie, token, user }
}

/** GET render of /verify-email-change (mail scanners, prefetch, and HEAD share this path). */
async function getConfirmPage(token: string) {
  const { default: VerifyEmailChangePage } = await import('../app/verify-email-change/page')
  return VerifyEmailChangePage({ searchParams: Promise.resolve({ token }) })
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

before(() => {
  capture()
})

after(async () => {
  for (const undo of restore.reverse()) undo()
  const created = await database.select({ id: users.id }).from(users).where(like(users.email, `%@${emailDomain}`))
  const ids = created.map((row) => row.id)
  const owned = ids.length
    ? await database
        .select({ id: memberships.workspaceId })
        .from(memberships)
        .where(and(inArray(memberships.userId, ids), eq(memberships.role, 'owner')))
    : []
  if (ids.length) {
    await database.delete(pendingEmailChanges).where(inArray(pendingEmailChanges.userId, ids))
    await database.delete(memberships).where(inArray(memberships.userId, ids))
    await database.delete(sessions).where(inArray(sessions.userId, ids))
    await database.delete(accounts).where(inArray(accounts.userId, ids))
  }
  const wsIds = owned.map((row) => row.id)
  if (wsIds.length) await database.delete(workspaces).where(inArray(workspaces.id, wsIds))
  if (ids.length) await database.delete(users).where(inArray(users.id, ids))
  await pool?.end()
})

describe('changing the email while signed in', () => {
  it('keeps the old email live until the new one is confirmed, then switches', async () => {
    assert.equal(CHANGE_EMAIL_ENDPOINT, '/api/session/change-email')
    const oldAddress = email('keep-old')
    const newAddress = email('keep-new')
    await createUser(oldAddress)
    const cookie = await signInCookie(oldAddress)
    clearSentMail()

    const response = await handleEmailChange(
      changeRequest(cookie, { currentPassword: PASSWORD, newEmail: newAddress }),
      routeMocks(),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    const stillOld = await userByEmail(oldAddress)
    assert.ok(stillOld)
    assert.equal(await userByEmail(newAddress), null)
    assert.equal(await signInStatus(oldAddress), 200, 'the old email still signs in before confirm')
    assert.notEqual(await signInStatus(newAddress), 200, 'the new email cannot sign in before confirm')

    await settle()
    assert.equal(sentMail.length, 1)
    assert.equal(sentMail[0]?.to, newAddress)
    const token = tokenFrom(sentMail[0]!)
    const link = buildEmailChangePageUrl(APP_URL, token)
    assert.ok(sentMail[0]!.text.includes(link))
    assert.equal(new URL(link).pathname, VERIFY_EMAIL_CHANGE_PAGE)

    const pending = await pendingFor(stillOld.id)
    assert.ok(pending)
    assert.equal(pending.pendingEmail, newAddress)
    assert.equal(pending.tokenHash, createHash('sha256').update(token, 'utf8').digest('hex'))
    assert.ok(!JSON.stringify(pending).includes(token), 'raw token is not stored')
    const ttl = pending.expiresAt.getTime() - pending.createdAt.getTime()
    assert.ok(Math.abs(ttl - EMAIL_CHANGE_TTL_MS) < 60_000, 'expiry is 24 hours')

    const verified = await handleEmailChangeVerify(token, routeMocks())
    assert.equal(verified.status, 200)
    assert.deepEqual(await verified.json(), { ok: true })
    await settle()

    assert.equal(await userByEmail(oldAddress), null)
    const switched = await userByEmail(newAddress)
    assert.ok(switched)
    assert.equal(switched.emailVerified, true)
    assert.equal(await pendingFor(switched.id), null)
    assert.equal(await signInStatus(newAddress), 200, 'the new email signs in after confirm')
    assert.notEqual(await signInStatus(oldAddress), 200, 'the old email no longer signs in')

    const notice = sentMail.find((message) => message.to === oldAddress)
    assert.ok(notice, 'a notice is sent to the previous address')
    const expectedNotice = buildEmailChangedNotice({ to: oldAddress })
    assert.equal(notice.subject, expectedNotice.subject)
    assert.equal(notice.text, expectedNotice.text)
    assert.ok(!/https?:\/\//.test(notice.text), 'no link in the old-address notice')
    assert.ok(!notice.text.includes(token), 'no token in the old-address notice')
  })

  it('a wrong current password is refused and stores nothing', async () => {
    const address = email('wrong-password')
    await createUser(address)
    const cookie = await signInCookie(address)
    clearSentMail()
    const response = await handleEmailChange(
      changeRequest(cookie, { currentPassword: 'not-the-password', newEmail: email('unused-new') }),
      routeMocks(),
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { code: 'INVALID_PASSWORD' })
    const user = await userByEmail(address)
    assert.ok(user)
    assert.equal(await pendingFor(user.id), null)
    assert.equal(sentMail.length, 0)
    assert.equal(await signInStatus(address), 200)
  })

  it('an expired token is refused with the generic error and changes nothing', async () => {
    const oldAddress = email('expired-old')
    const newAddress = email('expired-new')
    await createUser(oldAddress)
    const cookie = await signInCookie(oldAddress)
    clearSentMail()
    await handleEmailChange(changeRequest(cookie, { currentPassword: PASSWORD, newEmail: newAddress }), routeMocks())
    await settle()
    const token = tokenFrom(sentMail[0]!)
    const user = await userByEmail(oldAddress)
    assert.ok(user)
    await database
      .update(pendingEmailChanges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pendingEmailChanges.userId, user.id))

    const verified = await handleEmailChangeVerify(token, routeMocks())
    assert.equal(verified.status, 400)
    assert.deepEqual(await verified.json(), { error: 'invalid_token' })
    assert.ok(await userByEmail(oldAddress))
    assert.equal(await userByEmail(newAddress), null)
  })

  it('a used token cannot be presented again', async () => {
    const oldAddress = email('reuse-old')
    const newAddress = email('reuse-new')
    await createUser(oldAddress)
    const cookie = await signInCookie(oldAddress)
    clearSentMail()
    await handleEmailChange(changeRequest(cookie, { currentPassword: PASSWORD, newEmail: newAddress }), routeMocks())
    await settle()
    const token = tokenFrom(sentMail[0]!)
    assert.equal((await handleEmailChangeVerify(token, routeMocks())).status, 200)
    const again = await handleEmailChangeVerify(token, routeMocks())
    assert.equal(again.status, 400)
    assert.deepEqual(await again.json(), { error: 'invalid_token' })
    assert.ok(await userByEmail(newAddress))
    assert.equal(await userByEmail(oldAddress), null)
  })

  it('a new request replaces the earlier pending token', async () => {
    const oldAddress = email('replace-old')
    const firstNew = email('replace-first')
    const secondNew = email('replace-second')
    await createUser(oldAddress)
    const cookie = await signInCookie(oldAddress)
    clearSentMail()
    await handleEmailChange(changeRequest(cookie, { currentPassword: PASSWORD, newEmail: firstNew }), routeMocks())
    await settle()
    const firstToken = tokenFrom(sentMail[0]!)
    clearSentMail()
    await handleEmailChange(changeRequest(cookie, { currentPassword: PASSWORD, newEmail: secondNew }), routeMocks())
    await settle()
    const secondToken = tokenFrom(sentMail[0]!)
    assert.notEqual(firstToken, secondToken)

    const first = await handleEmailChangeVerify(firstToken, routeMocks())
    assert.equal(first.status, 400)
    assert.deepEqual(await first.json(), { error: 'invalid_token' })
    assert.ok(await userByEmail(oldAddress))

    const second = await handleEmailChangeVerify(secondToken, routeMocks())
    assert.equal(second.status, 200)
    assert.ok(await userByEmail(secondNew))
    assert.equal(await userByEmail(firstNew), null)
    assert.equal(await userByEmail(oldAddress), null)
  })

  it('refuses when the new email is taken between request and confirm', async () => {
    const oldAddress = email('race-old')
    const newAddress = email('race-new')
    await createUser(oldAddress)
    const cookie = await signInCookie(oldAddress)
    clearSentMail()
    await handleEmailChange(changeRequest(cookie, { currentPassword: PASSWORD, newEmail: newAddress }), routeMocks())
    await settle()
    const token = tokenFrom(sentMail[0]!)

    await createUser(newAddress, 'Taken')
    const verified = await handleEmailChangeVerify(token, routeMocks())
    assert.equal(verified.status, 400)
    assert.deepEqual(await verified.json(), { error: 'invalid_token' })
    assert.ok(await userByEmail(oldAddress), 'the requester keeps the original email')
    const taken = await userByEmail(newAddress)
    assert.ok(taken)
    assert.equal(taken.name, 'Taken')
  })

  it('refuses a case-insensitive duplicate at confirm', async () => {
    const oldAddress = email('case-old')
    const newAddress = email('case-new')
    await createUser(oldAddress)
    const cookie = await signInCookie(oldAddress)
    clearSentMail()
    await handleEmailChange(changeRequest(cookie, { currentPassword: PASSWORD, newEmail: newAddress }), routeMocks())
    await settle()
    const token = tokenFrom(sentMail[0]!)

    const mixed = `Case-New@${emailDomain}`
    await database.insert(users).values({
      id: newId('usr').slice(0, 36),
      email: mixed,
      name: 'Mixed',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const verified = await handleEmailChangeVerify(token, routeMocks())
    assert.equal(verified.status, 400)
    assert.deepEqual(await verified.json(), { error: 'invalid_token' })
    assert.ok(await userByEmail(oldAddress))
    const rows = await database.select().from(users).where(eq(users.email, mixed)).limit(1)
    assert.equal(rows[0]?.name, 'Mixed')
  })

  it('answers the same way when the new email is already taken at request time', async () => {
    const requester = email('enum-old')
    const taken = email('enum-taken')
    const free = email('enum-free')
    await createUser(requester)
    await createUser(taken, 'Already')
    const cookie = await signInCookie(requester)
    clearSentMail()

    const takenResponse = await handleEmailChange(
      changeRequest(cookie, { currentPassword: PASSWORD, newEmail: taken }),
      routeMocks(),
    )
    const takenBody = await takenResponse.json()
    await settle()
    const mailAfterTaken = sentMail.length
    const user = await userByEmail(requester)
    assert.ok(user)
    assert.equal(await pendingFor(user.id), null)

    const freeResponse = await handleEmailChange(
      changeRequest(cookie, { currentPassword: PASSWORD, newEmail: free }),
      routeMocks(),
    )
    assert.equal(takenResponse.status, freeResponse.status)
    assert.deepEqual(takenBody, await freeResponse.json())
    await settle()
    assert.equal(mailAfterTaken, 0, 'a taken address is not emailed a confirmation')
    assert.equal(sentMail.some((message) => message.to === taken), false)
    assert.ok(sentMail.some((message) => message.to === free))
  })

  it('unknown, used-shape and empty tokens share one generic error', async () => {
    const unknown = generateEmailChangeToken()
    tokensSeen.push(unknown)
    for (const token of [unknown, 'not-a-token', '', 1, null]) {
      const response = await handleEmailChangeVerify(token, routeMocks())
      assert.equal(response.status, 400, JSON.stringify(token))
      assert.deepEqual(await response.json(), { error: 'invalid_token' })
    }
  })
})

describe('email change request policy', () => {
  it('rejects an unauthenticated request with 401 and never stores a pending row', async () => {
    const before = (await database.select({ id: pendingEmailChanges.id }).from(pendingEmailChanges)).length
    const response = await handleEmailChange(
      changeRequest(undefined, { currentPassword: PASSWORD, newEmail: email('no-session') }),
      routeMocks(),
    )
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'unauthorized' })
    const after = (await database.select({ id: pendingEmailChanges.id }).from(pendingEmailChanges)).length
    assert.equal(after, before)
  })

  it('rejects a request missing either field with 400', async () => {
    const address = email('missing-fields')
    await createUser(address)
    const cookie = await signInCookie(address)
    for (const body of [{ newEmail: email('x') }, { currentPassword: PASSWORD }, {}]) {
      const response = await handleEmailChange(changeRequest(cookie, body), routeMocks())
      assert.equal(response.status, 400, JSON.stringify(body))
    }
  })

  it('rejects a malformed email without checking whether it is taken', async () => {
    const address = email('bad-format')
    await createUser(address)
    const cookie = await signInCookie(address)
    const response = await handleEmailChange(
      changeRequest(cookie, { currentPassword: PASSWORD, newEmail: 'not-an-email' }),
      routeMocks(),
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { code: 'INVALID_EMAIL' })
  })

  it('throttles attempts per client and then answers 429', async () => {
    const address = email('throttled')
    await createUser(address)
    const cookie = await signInCookie(address)
    const shared = createEmailChangeAttemptLimiter()
    const deps = routeMocks({
      clientKey: (headers) => headers.get('x-client') ?? 'anon',
      allow: shared,
    })

    for (let attempt = 0; attempt < EMAIL_CHANGE_ATTEMPT_LIMIT; attempt += 1) {
      const response = await handleEmailChange(
        changeRequest(cookie, { currentPassword: 'wrong-password', newEmail: email('t') }, { 'x-client': 'a' }),
        deps,
      )
      assert.equal(response.status, 400, `attempt ${attempt}`)
    }
    const blocked = await handleEmailChange(
      changeRequest(cookie, { currentPassword: 'wrong-password', newEmail: email('t') }, { 'x-client': 'a' }),
      deps,
    )
    assert.equal(blocked.status, 429)
    assert.deepEqual(await blocked.json(), { error: 'too_many_attempts' })

    const other = await handleEmailChange(
      changeRequest(cookie, { currentPassword: 'wrong-password', newEmail: email('t') }, { 'x-client': 'b' }),
      deps,
    )
    assert.equal(other.status, 400, 'the limit is per client')
  })

  it('the change-email route refuses cross-site and non-JSON requests', async () => {
    const { POST } = await import('../app/api/session/change-email/route')
    const crossSite = new NextRequest(`${APP_URL}${CHANGE_EMAIL_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3002', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal((await POST(crossSite)).status, 403)

    const wrongType = new NextRequest(`${APP_URL}${CHANGE_EMAIL_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal((await POST(wrongType)).status, 415)
  })

  it('the verify route refuses cross-site and non-JSON requests', async () => {
    const { POST } = await import('../app/api/session/verify-email-change/route')
    const crossSite = new NextRequest(`${APP_URL}${VERIFY_EMAIL_CHANGE_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3002', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal((await POST(crossSite)).status, 403)

    const wrongType = new NextRequest(`${APP_URL}${VERIFY_EMAIL_CHANGE_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal((await POST(wrongType)).status, 415)
  })
})

describe('confirm is POST-only (GET/HEAD/prefetch must not consume the token)', () => {
  it('a GET-only visit (mail scanner) leaves the email and pending row; a later POST still succeeds', async () => {
    const { oldAddress, newAddress, token, user } = await startPendingChange('get-old', 'get-new')
    const tree = await getConfirmPage(token)
    assert.ok(tree)

    const { GET, HEAD, POST } = await import('../app/api/session/verify-email-change/route')
    const peek = `${APP_URL}${VERIFY_EMAIL_CHANGE_ENDPOINT}?token=${token}`
    assert.equal((await GET()).status, 405)
    assert.equal((await HEAD()).status, 405)
    const prefetch = new NextRequest(peek, { method: 'GET' })
    assert.equal(prefetch.method, 'GET')
    assert.equal((await GET()).status, 405)

    assert.ok(await userByEmail(oldAddress), 'GET must not switch the live email')
    assert.equal(await userByEmail(newAddress), null)
    const pending = await pendingFor(user.id)
    assert.ok(pending, 'GET must not clear the pending row')
    assert.equal(pending.tokenHash, hashEmailChangeToken(token))

    const confirmed = new NextRequest(`${APP_URL}${VERIFY_EMAIL_CHANGE_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal((await POST(confirmed)).status, 200)
    assert.ok(await userByEmail(newAddress))
    assert.equal(await userByEmail(oldAddress), null)
    assert.equal(await pendingFor(user.id), null)
  })

  it('a POST without same-origin is rejected and the token stays valid', async () => {
    const { oldAddress, newAddress, token, user } = await startPendingChange('csrf-old', 'csrf-new')
    const { POST } = await import('../app/api/session/verify-email-change/route')
    const crossSite = new NextRequest(`${APP_URL}${VERIFY_EMAIL_CHANGE_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3002', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal((await POST(crossSite)).status, 403)
    assert.ok(await userByEmail(oldAddress))
    assert.equal(await userByEmail(newAddress), null)
    assert.ok(await pendingFor(user.id), 'a rejected POST must not consume the token')

    const sameOrigin = new NextRequest(`${APP_URL}${VERIFY_EMAIL_CHANGE_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal((await POST(sameOrigin)).status, 200)
    assert.ok(await userByEmail(newAddress))
    assert.equal(await userByEmail(oldAddress), null)
  })
})

describe('submitEmailChange outcome mapping', () => {
  const fake = (status: number, body: unknown): typeof fetch => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('maps every server answer to a fixed message', async () => {
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), fake(200, { ok: true })), { ok: true })
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), fake(401, {})), {
      ok: false,
      message: CHANGE_EMAIL_UNAUTHENTICATED_MESSAGE,
    })
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), fake(429, {})), {
      ok: false,
      message: CHANGE_EMAIL_THROTTLED_MESSAGE,
    })
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), fake(500, {})), {
      ok: false,
      message: CHANGE_EMAIL_RETRY_MESSAGE,
    })
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), fake(400, { code: 'INVALID_PASSWORD' })), {
      ok: false,
      message: CURRENT_PASSWORD_INCORRECT_MESSAGE,
    })
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), fake(400, { code: 'INVALID_EMAIL' })), {
      ok: false,
      message: INVALID_EMAIL_MESSAGE,
    })
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), fake(400, { code: 'WHATEVER' })), {
      ok: false,
      message: CHANGE_EMAIL_FAILED_MESSAGE,
    })
    const offline: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    assert.deepEqual(await submitEmailChange(PASSWORD, email('map'), offline), {
      ok: false,
      message: RESET_REQUEST_NETWORK_MESSAGE,
    })
  })

  it('maps verify failures to the generic invalid-link message', async () => {
    assert.deepEqual(await submitEmailChangeVerification('token', fake(200, { ok: true })), { ok: true })
    assert.deepEqual(await submitEmailChangeVerification('token', fake(400, { error: 'invalid_token' })), {
      ok: false,
      message: VERIFY_EMAIL_CHANGE_INVALID_MESSAGE,
    })
    assert.deepEqual(await submitEmailChangeVerification('token', fake(400, { error: 'expired' })), {
      ok: false,
      message: VERIFY_EMAIL_CHANGE_INVALID_MESSAGE,
    })
  })
})

describe('email change wiring (static)', () => {
  it('the confirmation page is public, sends no-referrer, and does not consume on GET', async () => {
    assert.ok(PUBLIC_PATHS.includes(VERIFY_EMAIL_CHANGE_PAGE))
    const page = fs.readFileSync(path.join(__dirname, '../app/verify-email-change/page.tsx'), 'utf-8')
    assert.match(page, /referrer:\s*'no-referrer'/)
    assert.ok(page.includes('<ConfirmEmailChangeForm'))
    assert.ok(!page.includes('handleEmailChangeVerify'), 'GET must not call the verify handler')
    const form = fs.readFileSync(path.join(__dirname, '../components/confirm-email-change-form.tsx'), 'utf-8')
    assert.ok(form.includes('Confirm'))
    assert.ok(form.includes('submitEmailChangeVerification'))
    const config = fs.readFileSync(path.join(__dirname, '../next.config.mjs'), 'utf-8')
    assert.ok(config.includes("source: '/verify-email-change'"))
    assert.ok(config.includes("'no-referrer'"))
  })

  it('the security page renders the change-email form next to the password form', () => {
    const page = fs.readFileSync(path.join(__dirname, '../app/settings/security/page.tsx'), 'utf-8')
    assert.ok(page.includes('<ChangeEmailForm'))
    assert.ok(page.includes('<ChangePasswordForm'))
    const form = fs.readFileSync(path.join(__dirname, '../components/change-email-form.tsx'), 'utf-8')
    assert.ok(form.includes('name="currentPassword"'), 'the current password is required')
    assert.ok(form.includes('name="newEmail"'))
  })

  it('tokens are 256-bit and unique', () => {
    const a = generateEmailChangeToken()
    const b = generateEmailChangeToken()
    assert.equal(Buffer.from(a, 'base64url').length, 32)
    assert.notEqual(a, b)
    assert.equal(hashEmailChangeToken(a).length, 64)
    assert.notEqual(hashEmailChangeToken(a), a)
  })

  it('the confirmation builder puts the token only in the link', () => {
    const token = generateEmailChangeToken()
    tokensSeen.push(token)
    const mail = buildEmailChangeVerificationEmail({
      to: email('builder'),
      link: buildEmailChangePageUrl(APP_URL, token),
    })
    assert.ok(mail.text.includes(token))
    assert.equal(mail.text.split(token).length - 1, 1)
    const notice = buildEmailChangedNotice({ to: email('old') })
    assert.ok(!notice.text.includes(token))
    assert.ok(!/https?:\/\//.test(notice.text))
  })

  it('the fire-and-forget senders match the shared builders', async () => {
    const outbox: { to: string; subject: string; text: string }[] = []
    const send = async (message: { to: string; subject: string; text: string }) => {
      outbox.push(message)
      return { delivered: true }
    }
    const token = generateEmailChangeToken()
    tokensSeen.push(token)
    await createSendEmailChangeVerification(APP_URL, send)({ to: email('send'), token })
    await createSendEmailChangedNotice(send)({ to: email('notice') })
    await settle()
    assert.equal(outbox.length, 2)
    assert.deepEqual(outbox[0], buildEmailChangeVerificationEmail({ to: email('send'), link: buildEmailChangePageUrl(APP_URL, token) }))
    assert.deepEqual(outbox[1], buildEmailChangedNotice({ to: email('notice') }))
  })
})

describe('email change tokens stay out of logs', () => {
  it('does not log a confirmation token or its hash', () => {
    assert.ok(tokensSeen.length > 3)
    const all = logged.join('\n')
    for (const token of tokensSeen) {
      assert.ok(!all.includes(token), 'token must not be logged')
      assert.ok(!all.includes(hashEmailChangeToken(token)), 'token hash must not be logged')
    }
  })

  it('deps.log never receives the raw confirmation token', async () => {
    const lines: string[] = []
    const deps = routeMocks({ log: (line) => lines.push(line) })
    const { token, newAddress } = await startPendingChange('log-old', 'log-new', deps)
    assert.equal((await handleEmailChangeVerify(token, deps)).status, 200)
    assert.ok(await userByEmail(newAddress))
    const joined = lines.join('\n')
    assert.ok(!joined.includes(token), 'deps.log must not receive the raw token')
    assert.ok(!joined.includes(hashEmailChangeToken(token)), 'deps.log must not receive the token hash')
  })
})
