/**
 * LIVE password-change tests against real Postgres and the app's real Better
 * Auth instance (same harness as lib/email-change.test.ts): the route handler
 * runs with its production dependencies, so these tests are wired to what
 * ships.
 *
 * 1. Session revoke: two signed-in sessions, a change from session A must
 *    sign session B out (the revokeOtherSessions call in
 *    lib/password-change-route.ts is load-bearing: remove it and this test
 *    fails, because session B keeps answering 200), while session A
 *    continues on the rotated cookie the route forwards.
 * 2. No password in the logs: a change made with a canary password, run
 *    through the real mailer path, must leave the canary in no line of log
 *    output (console, stdout, stderr) and in no delivered email. Any code
 *    that logs the password makes this test fail.
 * 3. Revocation is scoped to the changing account: an unrelated account's
 *    live session must survive the change (a revoke keyed on
 *    user_id <> current goes red here).
 * 4. Log line shape: a success emits no password-change line, no 64-char
 *    hex digest (the sha256 of a password included) and no session token,
 *    and the one allowed fixed line (the throttle log) is emitted verbatim.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'
process.env.HITLY_SIGNUP_ENABLED = '1'

import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { and, eq, inArray, like } from 'drizzle-orm'
import { accounts, memberships, sessions, users, workspaces } from '@hitly/db/schema'
import { clearSentMail, sendMail, sentMail } from '@hitly/mail'
import { auth } from './auth'
import { db, pool } from './db'
import { CHANGE_PASSWORD_ENDPOINT } from './password-change'
import { CHANGE_PASSWORD_LIMITED_LOG } from './change-password-limit'
import { handlePasswordChange } from './password-change-route'
import { createSendPasswordChangedNotification } from './password-change-emails'
import { newId } from './ids'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `password-change-${run}.example.com`
const PASSWORD = 'correct-horse-battery'
const CANARY = `canary-Pw-${run}-Vh8xTq4Zr`

const logged: string[] = []
const restore: Array<() => void> = []

/** Records every console line and every byte written to stdout/stderr. */
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

// The password-changed notice renders the branded email on a detached
// fire-and-forget chain; track it so assertions drain pending sends
// deterministically instead of sleeping.
const inflight = new Set<Promise<unknown>>()
function trackMail(chain: Promise<unknown>) {
  inflight.add(chain)
  void chain.finally(() => inflight.delete(chain))
}
async function settle() {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight])
  }
}
const trackedNotify = createSendPasswordChangedNotification(sendMail, { track: trackMail })

async function createUser(address: string, password = PASSWORD) {
  await authApi.signUpEmail({ body: { email: address, name: 'Alex', password } })
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

/** The session cookie value alone; the token is opaque to the test. */
function cookieToken(cookie: string): string | null {
  for (const part of cookie.split('; ')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index)
    const value = part.slice(index + 1)
    if (name.toLowerCase().includes('session') && value) return value
  }
  return null
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

async function sessionUser(cookie: string) {
  return authApi.getSession({ headers: new Headers({ cookie, origin: APP_URL }) })
}

/**
 * Session rows of one account. The token column is not the cookie value
 * (Better Auth stores a digest), so the live assertions go through
 * auth.api.getSession and the database is pinned by counting rows.
 */
async function liveSessionCount(userId: string) {
  return (await database.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length
}

function changeRequest(cookie: string, body: unknown, client: string) {
  return new NextRequest(`${APP_URL}${CHANGE_PASSWORD_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP_URL,
      cookie,
      'x-forwarded-for': client,
    },
    body: JSON.stringify(body),
  })
}

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
    await database.delete(memberships).where(inArray(memberships.userId, ids))
    await database.delete(sessions).where(inArray(sessions.userId, ids))
    await database.delete(accounts).where(inArray(accounts.userId, ids))
  }
  const wsIds = owned.map((row) => row.id)
  if (wsIds.length) await database.delete(workspaces).where(inArray(workspaces.id, wsIds))
  if (ids.length) await database.delete(users).where(inArray(users.id, ids))
  await pool?.end()
})

describe('signed-in password change on real Postgres', () => {
  it('revokes the other session and keeps the changing device signed in', async () => {
    const address = email(`revoke-${run}`)
    await createUser(address)
    const cookieA = await signInCookie(address)
    const cookieB = await signInCookie(address)
    assert.ok(cookieA && cookieB && cookieA !== cookieB, 'two distinct sessions are signed in')
    const sessionA0 = await sessionUser(cookieA)
    assert.ok(sessionA0, 'session A starts valid')
    assert.ok(await sessionUser(cookieB), 'session B starts valid')
    const userId = sessionA0.user.id
    // Sign-up itself signs the account in (Better Auth), so the account now
    // holds three live sessions: the signup one plus the two under test.
    assert.equal(await liveSessionCount(userId), 3, 'the two sessions plus the signup one exist')

    clearSentMail()
    // Production dependencies (no changePassword override): the handler must
    // perform the real Better Auth change with revokeOtherSessions.
    const response = await handlePasswordChange(
      changeRequest(cookieA, { currentPassword: PASSWORD, newPassword: 'fresh-horse-stable' }, `203.0.113.${run.slice(-1)}`),
      { allow: () => true, notify: async () => {} },
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    // Session B is rejected: the route's default session lookup (the same
    // auth.api.getSession the API routes use) answers "no session", and the
    // change-password route turns that into a 401.
    assert.equal(await sessionUser(cookieB), null, 'session B no longer resolves to a user')
    const rejected = await handlePasswordChange(
      changeRequest(cookieB, { currentPassword: 'fresh-horse-stable', newPassword: 'third-horse-stable' }, `203.0.113.${run.slice(-1)}`),
      { allow: () => true, notify: async () => {} },
    )
    assert.equal(rejected.status, 401, 'the revoked session is rejected with 401')
    assert.deepEqual(await rejected.json(), { error: 'unauthorized' })

    // Session A continues on the rotated cookie the route forwarded.
    const reissued = cookieHeader(response)
    assert.ok(reissued, 'the success response forwards the rotated session cookie')
    const sessionA = await sessionUser(reissued)
    assert.ok(sessionA, 'the reissued session works')
    assert.equal(sessionA.user.email, address.toLowerCase())
    assert.notEqual(cookieToken(reissued), cookieToken(cookieA), 'the session token was rotated')
    assert.equal(await liveSessionCount(userId), 1, 'only the rotated session row remains')

    // The new password signs in, the old one does not.
    assert.equal(await signInStatus(address, 'fresh-horse-stable'), 200)
    assert.notEqual(await signInStatus(address, PASSWORD), 200)
  })

  it('revokes only this account: another user keeps their signed-in session', async () => {
    const address = email(`collateral-${run}`)
    await createUser(address)
    const cookieA = await signInCookie(address)

    // Fixture: a second, unrelated account with its own live session. The
    // revoke predicate must be scoped to the changing user; a revoke that
    // instead hits sessions where user_id <> current signs this account out
    // and this test goes red.
    const otherAddress = email(`bystander-${run}`)
    await createUser(otherAddress)
    const cookieOther = await signInCookie(otherAddress)
    const otherBefore = await sessionUser(cookieOther)
    assert.ok(otherBefore, 'the other user session is valid before the change')
    const otherUserId = otherBefore.user.id
    assert.notEqual(otherUserId, (await sessionUser(cookieA))?.user.id, 'the two sessions are different accounts')
    const otherCountBefore = await liveSessionCount(otherUserId)
    assert.ok(otherCountBefore >= 1, 'the other user has live session rows before the change')

    const response = await handlePasswordChange(
      changeRequest(cookieA, { currentPassword: PASSWORD, newPassword: 'stable-horse-fresh' }, `203.0.113.${run.slice(-1)}`),
      { allow: () => true, notify: async () => {} },
    )
    assert.equal(response.status, 200, 'the change itself succeeds')

    // The bystander is untouched: same cookie, same account, same rows.
    const otherAfter = await sessionUser(cookieOther)
    assert.ok(otherAfter, 'the other user session still resolves after the change')
    assert.equal(otherAfter.user.id, otherUserId, 'the bystander cookie still names the same account')
    assert.equal(await liveSessionCount(otherUserId), otherCountBefore, 'no session row of the other user was revoked')

    // And the change still did its job on its own account.
    const reissued = cookieHeader(response)
    assert.ok(await sessionUser(reissued), 'the changing device stays signed in')
    assert.equal(await sessionUser(cookieA), null, 'the pre-change session of the changing account is gone')
  })

  it('pins the password-change log line shape: fixed lines only, no hashes, no tokens', async () => {
    const address = email(`logshape-${run}`)
    await createUser(address)
    const cookie = await signInCookie(address)
    const newPassword = `logshape-Pw-${run}-Nc5tY8wRa`
    const newHash = createHash('sha256').update(newPassword).digest('hex')

    await settle()
    clearSentMail()
    const before = logged.length
    // Production log path (no log override): whatever the change emits must
    // match the pinned shapes. A mutant that logs log(sha256(newPassword))
    // puts a 64-char hex digest in the output and goes red here.
    const response = await handlePasswordChange(
      changeRequest(cookie, { currentPassword: PASSWORD, newPassword }, `203.0.113.${run.slice(-1)}`),
      { allow: () => true, notify: trackedNotify },
    )
    assert.equal(response.status, 200, 'the log-shape change succeeds')
    await settle()
    const during = logged.slice(before)
    const joined = during.join('\n')

    // Shape pin 1: a clean success emits no password-change line at all.
    const routeLines = during.filter((line) => line.includes('[hitly password-change]'))
    assert.deepEqual(routeLines, [], 'a successful change logs no password-change line')

    // Shape pin 2: no hash of either password and no hash-shaped string
    // anywhere in the output (kills log(sha256(newPassword)) mutants).
    assert.ok(!joined.includes(newHash), 'the sha256 of the new password is never logged')
    assert.ok(!joined.includes(newHash.toUpperCase()), 'no uppercase sha256 of the new password either')
    assert.ok(!joined.includes(PASSWORD), 'the current password is never logged')
    assert.ok(!joined.includes(newPassword), 'the new password is never logged')
    assert.ok(!/[0-9a-f]{64}/i.test(joined), 'no 64-char hex digest appears in log output')

    // Shape pin 3: no session token value reaches the log.
    const oldToken = cookieToken(cookie)
    assert.ok(oldToken, 'the signed-in cookie carries a session token')
    assert.ok(!joined.includes(oldToken), 'the pre-change session token is never logged')
    const newToken = cookieToken(cookieHeader(response))
    assert.ok(newToken, 'the rotated cookie carries a session token')
    assert.ok(!joined.includes(newToken), 'the rotated session token is never logged')

    // Shape pin 4: the one line the handler is allowed to log (throttle) is
    // emitted verbatim and carries no secret.
    const throttleBefore = logged.length
    const throttled = await handlePasswordChange(
      changeRequest(cookieHeader(response), { currentPassword: newPassword, newPassword: 'fifth-horse-stable' }, `203.0.113.${run.slice(-1)}`),
      { allow: () => false },
    )
    assert.equal(throttled.status, 429, 'the spent budget answers 429')
    const throttleLines = logged.slice(throttleBefore).filter((line) => line.includes('[hitly password-change]'))
    assert.equal(throttleLines.length, 1, 'the throttle path logs exactly one password-change line')
    assert.equal(throttleLines[0].trim(), CHANGE_PASSWORD_LIMITED_LOG, 'the throttle line matches the pinned fixed text verbatim')
    assert.ok(!/[0-9a-f]{64}/i.test(throttleLines[0]), 'the pinned line carries no hash')
    assert.ok(!throttleLines[0].includes(newPassword) && !throttleLines[0].includes(newToken ?? ''), 'the pinned line carries no password or token')
  })

  it('leaves the canary password in no log line and no email', async () => {
    const address = email(`canary-${run}`)
    await createUser(address)
    const cookie = await signInCookie(address)

    await settle()
    clearSentMail()
    const before = logged.length
    // No log override and the real notification mailer (tracked so the test
    // can drain it): every line the change can produce (handler logs, Better
    // Auth logger, mail path) is captured.
    const response = await handlePasswordChange(
      changeRequest(cookie, { currentPassword: PASSWORD, newPassword: CANARY }, `203.0.113.${run.slice(-1)}`),
      { allow: () => true, notify: trackedNotify },
    )
    assert.equal(response.status, 200, 'the canary change itself succeeds')
    await settle()

    const during = logged.slice(before).join('\n')
    assert.ok(!during.includes(CANARY), 'the new password never appears in log output')
    assert.ok(!during.includes(PASSWORD), 'the current password never appears in log output')
    assert.ok(!JSON.stringify(logged).includes(CANARY), 'the canary is nowhere in the captured output')
    assert.ok(sentMail.length >= 1, 'the password-changed email went out')
    assert.ok(!JSON.stringify(sentMail).includes(CANARY), 'the canary is not in any delivered email')
    assert.equal(await signInStatus(address, CANARY), 200, 'the canary became the password')
  })
})
