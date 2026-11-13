/**
 * Public sign-up email verification against real Postgres and the app's real
 * Better Auth instance: hashed single-use token, expiry, wrong token, replay,
 * resend rate limit, generic replies, flag set only on confirm, and the
 * invite and email-change paths left alone.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'
process.env.HITLY_SIGNUP_ENABLED = '1'

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { and, eq, inArray, like } from 'drizzle-orm'
import {
  accountSecurityEvents,
  accounts,
  invites,
  memberships,
  pendingEmailChanges,
  pendingEmailVerifications,
  sessions,
  users,
  workspaces,
} from '@hitly/db/schema'
import { clearSentMail as clearSentMailMemory, sendMail, sentMail } from '@hitly/mail'
import { auth } from './auth'
import { db, pool } from './db'
import {
  EMAIL_VERIFICATION_TTL_MS,
  EMAIL_VERIFIED_EVENT,
  RESEND_EMAIL_VERIFICATION_ENDPOINT,
  VERIFY_EMAIL_ENDPOINT,
  VERIFY_EMAIL_PAGE,
} from './email-verification'
import { drainEmailVerificationMail, generateEmailVerificationToken, hashEmailVerificationToken } from './email-verification-issue'
import {
  RESEND_EMAIL_VERIFICATION_LIMIT,
  RESEND_EMAIL_VERIFICATION_WINDOW_MS,
  createResendEmailVerificationLimiter,
} from './email-verification-limit'
import { handleEmailVerificationConfirm, handleResendEmailVerification, type EmailVerificationRouteDeps } from './email-verification-route'
import {
  createSendEmailChangedNotice,
  createSendEmailChangeVerification,
} from './email-change-emails'
import { handleEmailChange, handleEmailChangeVerify } from './email-change-route'
import { PUBLIC_PATHS } from './constants'
import { newId } from './ids'
import { acceptInviteWithNewAccount, generateInviteToken, hashInviteToken } from './invites'
import { createRateLimiter } from './reset-check-limit'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `verify-${run}.example.com`
const PASSWORD = 'correct-horse-battery'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const logged: string[] = []
const tokensSeen: string[] = []
const restore: Array<() => void> = []
const extraWorkspaceIds = new Set<string>()
const changeInflight = new Set<Promise<unknown>>()

function trackChangeMail(chain: Promise<unknown>) {
  changeInflight.add(chain)
  void chain.finally(() => changeInflight.delete(chain))
}

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
}

function email(local: string) {
  return `${local}@${emailDomain}`
}

async function drainMail() {
  await drainEmailVerificationMail()
  while (changeInflight.size > 0) await Promise.allSettled([...changeInflight])
}

async function clearSentMail() {
  await drainMail()
  clearSentMailMemory()
}

async function userByEmail(address: string) {
  const rows = await database.select().from(users).where(eq(users.email, address.toLowerCase())).limit(1)
  return rows[0] ?? null
}

async function pendingFor(userId: string) {
  const rows = await database
    .select()
    .from(pendingEmailVerifications)
    .where(eq(pendingEmailVerifications.userId, userId))
    .limit(1)
  return rows[0] ?? null
}

async function verifiedEvents(userId: string) {
  return database
    .select()
    .from(accountSecurityEvents)
    .where(and(eq(accountSecurityEvents.userId, userId), eq(accountSecurityEvents.type, EMAIL_VERIFIED_EVENT)))
}

function tokenFrom(mail: { text: string }) {
  const match = mail.text.match(/\/verify-email\?token=([A-Za-z0-9_-]{43})/)
  assert.ok(match, 'verification email must contain the confirm link')
  tokensSeen.push(match[1]!)
  return match[1]!
}

async function createUser(local: string, name = 'Alex') {
  const address = email(local)
  await clearSentMail()
  const created = await authApi.signUpEmail({ body: { email: address, name, password: PASSWORD } })
  await drainMail()
  const user = await userByEmail(address)
  assert.ok(user)
  assert.equal(created.user.emailVerified, false)
  assert.equal(user.emailVerified, false, 'sign-up must not set email_verified')
  assert.equal(sentMail.length, 1)
  assert.equal(sentMail[0]?.to, address)
  const token = tokenFrom(sentMail[0]!)
  const pending = await pendingFor(user.id)
  assert.ok(pending)
  assert.equal(pending.tokenHash, hashEmailVerificationToken(token))
  assert.equal(pending.email, address, 'the token is stored against the address it was sent to')
  assert.notEqual(pending.tokenHash, token)
  assert.ok(!JSON.stringify(pending).includes(token), 'the raw token is not stored')
  const ttl = pending.expiresAt.getTime() - Date.now()
  assert.ok(ttl > EMAIL_VERIFICATION_TTL_MS - 60_000 && ttl <= EMAIL_VERIFICATION_TTL_MS + 5_000)
  assert.equal((await verifiedEvents(user.id)).length, 0, 'no audit row before confirm')
  return { address, user, token }
}

async function signInCookie(address: string) {
  const { headers } = await authApi.signInEmail({
    body: { email: address, password: PASSWORD },
    returnHeaders: true,
  })
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

async function signInStatus(address: string) {
  try {
    const response = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    return response.status
  } catch {
    return 401
  }
}

function resendRequest(cookie: string | undefined, client = 'a', body: unknown = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_URL,
    'x-test-client': client,
  }
  if (cookie) headers.cookie = cookie
  return new Request(`${APP_URL}${RESEND_EMAIL_VERIFICATION_ENDPOINT}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function routeDeps(overrides: Partial<EmailVerificationRouteDeps> = {}): EmailVerificationRouteDeps {
  return { log: () => {}, allow: () => true, clientKey: (headers) => headers.get('x-test-client') ?? 'a', ...overrides }
}

async function errorOf(token: unknown) {
  const response = await handleEmailVerificationConfirm(token, { log: () => {} })
  return { status: response.status, body: await response.json() }
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
    await database.delete(pendingEmailVerifications).where(inArray(pendingEmailVerifications.userId, ids))
    await database.delete(pendingEmailChanges).where(inArray(pendingEmailChanges.userId, ids))
    await database.delete(accountSecurityEvents).where(inArray(accountSecurityEvents.userId, ids))
    await database.delete(memberships).where(inArray(memberships.userId, ids))
    await database.delete(sessions).where(inArray(sessions.userId, ids))
    await database.delete(accounts).where(inArray(accounts.userId, ids))
  }
  const wsIds = [...new Set([...owned.map((row) => row.id), ...extraWorkspaceIds])]
  if (wsIds.length) {
    await database.delete(invites).where(inArray(invites.workspaceId, wsIds))
    await database.delete(memberships).where(inArray(memberships.workspaceId, wsIds))
    await database.delete(workspaces).where(inArray(workspaces.id, wsIds))
  }
  if (ids.length) await database.delete(users).where(inArray(users.id, ids))
  await pool?.end()
})

describe('public sign-up verification', () => {
  it('stores only the hash and leaves the account unverified until confirm', async () => {
    const { address, user, token } = await createUser('hash')
    assert.equal(await signInStatus(address), 200, 'unverified users can still sign in')
    const still = await userByEmail(address)
    assert.equal(still?.emailVerified, false)
    assert.equal((await pendingFor(user.id))?.tokenHash, hashEmailVerificationToken(token))
  })

  it('a GET of the confirm page and of the API does not set the flag or consume the token', async () => {
    const { address, user, token } = await createUser('get')
    const { default: VerifyEmailPage } = await import('../app/verify-email/page')
    const tree = await VerifyEmailPage({ searchParams: Promise.resolve({ token }) })
    assert.ok(tree)

    const { GET, HEAD, POST } = await import('../app/api/session/verify-email/route')
    const live = new NextRequest(`${APP_URL}${VERIFY_EMAIL_ENDPOINT}?token=${encodeURIComponent(token)}`)
    const get = GET as (request: NextRequest) => Response | Promise<Response>
    const head = HEAD as (request: NextRequest) => Response | Promise<Response>
    assert.equal((await get(live)).status, 405)
    assert.equal((await head(live)).status, 405)
    assert.equal((await userByEmail(address))?.emailVerified, false)
    const pending = await pendingFor(user.id)
    assert.ok(pending)
    assert.equal(pending.tokenHash, hashEmailVerificationToken(token))

    const confirmed = new NextRequest(`${APP_URL}${VERIFY_EMAIL_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const posted = await POST(confirmed)
    assert.equal(posted.status, 200)
    assert.equal(posted.headers.get('set-cookie'), null, 'confirm does not set a session cookie')
    assert.equal((await userByEmail(address))?.emailVerified, true)
    assert.equal(await pendingFor(user.id), null)
    assert.equal((await verifiedEvents(user.id)).length, 1)
  })

  it('sets the flag and writes email_verified only on a successful confirm', async () => {
    const { address, user, token } = await createUser('confirm')
    const response = await handleEmailVerificationConfirm(token, { log: () => {} })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    const updated = await userByEmail(address)
    assert.equal(updated?.emailVerified, true)
    assert.equal(updated?.email, address)
    assert.equal(await pendingFor(user.id), null)
    const events = await verifiedEvents(user.id)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, EMAIL_VERIFIED_EVENT)
  })

  it('rejects a wrong token, an expired token, a replay, and a malformed token with the same body', async () => {
    const { address, user, token } = await createUser('reject')
    const wrong = generateEmailVerificationToken()
    tokensSeen.push(wrong)
    const malformed = await errorOf('not-a-token')
    const wrongBody = await errorOf(wrong)
    assert.deepEqual(malformed, { status: 400, body: { error: 'invalid_token' } })
    assert.deepEqual(wrongBody, malformed)
    assert.equal((await userByEmail(address))?.emailVerified, false)
    assert.equal((await pendingFor(user.id))?.tokenHash, hashEmailVerificationToken(token))

    await database
      .update(pendingEmailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pendingEmailVerifications.userId, user.id))
    const expired = await errorOf(token)
    assert.deepEqual(expired, malformed)
    assert.equal((await userByEmail(address))?.emailVerified, false)
    assert.ok(await pendingFor(user.id), 'an expired token is not treated as a successful confirm')

    await database
      .update(pendingEmailVerifications)
      .set({ expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) })
      .where(eq(pendingEmailVerifications.userId, user.id))
    assert.equal((await handleEmailVerificationConfirm(token, { log: () => {} })).status, 200)
    const replay = await errorOf(token)
    assert.deepEqual(replay, malformed)
    assert.equal((await userByEmail(address))?.emailVerified, true)
    assert.equal((await verifiedEvents(user.id)).length, 1, 'replay does not write a second event')
    assert.equal(await pendingFor(user.id), null)
  })

  it('resend replaces the token, is rate limited per client, and answers generically', async () => {
    const { address, user, token } = await createUser('resend')
    const cookie = await signInCookie(address)
    const allow = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => 5_000 })
    const deps = routeDeps({ allow, clientKey: (headers) => headers.get('x-test-client') ?? 'a' })

    await clearSentMail()
    const first = await handleResendEmailVerification(resendRequest(cookie, 'a', { email: 'other@example.com' }), deps)
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true })
    await drainMail()
    assert.equal(sentMail.length, 1)
    assert.equal(sentMail[0]?.to, address, 'a body email does not choose the recipient')
    const replaced = tokenFrom(sentMail[0]!)
    assert.notEqual(replaced, token)

    await clearSentMail()
    const second = await handleResendEmailVerification(resendRequest(cookie, 'a'), deps)
    assert.deepEqual(await second.json(), { ok: true })
    await drainMail()
    const replacement = tokenFrom(sentMail[0]!)
    assert.notEqual(replacement, replaced)
    assert.equal((await pendingFor(user.id))?.tokenHash, hashEmailVerificationToken(replacement))
    assert.equal((await handleEmailVerificationConfirm(token, { log: () => {} })).status, 400)
    assert.equal((await handleEmailVerificationConfirm(replaced, { log: () => {} })).status, 400)
    assert.equal((await userByEmail(address))?.emailVerified, false)

    const blocked = await handleResendEmailVerification(resendRequest(cookie, 'a'), deps)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '900', 'a spent budget names the seconds left in its window')
    const blockedBody = await blocked.json()
    assert.deepEqual(blockedBody, { error: 'too_many_attempts' })
    assert.ok(!JSON.stringify(blockedBody).includes('@'))
    await drainMail()
    assert.equal(sentMail.length, 1, 'the limited request does not send another mail')

    const otherClient = await handleResendEmailVerification(resendRequest(cookie, 'b'), deps)
    assert.equal(otherClient.status, 200, 'the limit is per client')

    await database.update(users).set({ emailVerified: true }).where(eq(users.id, user.id))
    await clearSentMail()
    const verifiedAllow = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 9_000 })
    const verifiedDeps = routeDeps({ allow: verifiedAllow, clientKey: () => 'verified' })
    const already = await handleResendEmailVerification(resendRequest(cookie, 'verified'), verifiedDeps)
    assert.equal(already.status, 200)
    assert.deepEqual(await already.json(), { ok: true })
    await drainMail()
    assert.equal(sentMail.length, 0, 'an already-verified account is not mailed again')
    const verifiedBlocked = await handleResendEmailVerification(resendRequest(cookie, 'verified'), verifiedDeps)
    assert.equal(verifiedBlocked.status, 429)
    assert.equal(verifiedBlocked.headers.get('retry-after'), '900')
    assert.deepEqual(await verifiedBlocked.json(), blockedBody)

    const anonymous = await handleResendEmailVerification(
      resendRequest(undefined, 'anon', { email: address }),
      routeDeps({ getSessionUser: async () => null }),
    )
    const anonymousOther = await handleResendEmailVerification(
      resendRequest(undefined, 'anon', { email: 'nobody@example.com' }),
      routeDeps({ getSessionUser: async () => null }),
    )
    assert.equal(anonymous.status, 401)
    assert.deepEqual(await anonymous.json(), { error: 'unauthorized' })
    assert.deepEqual(await anonymousOther.json(), { error: 'unauthorized' })
  })

  it('new-account invite accept still sets the flag and does not send a verification mail', async () => {
    const previous = process.env.HITLY_SIGNUP_ENABLED
    process.env.HITLY_SIGNUP_ENABLED = '0'
    try {
      await assert.rejects(
        () => authApi.signUpEmail({ body: { email: email('closed'), name: 'Closed', password: PASSWORD } }),
        /disabled/i,
      )
      const address = email('invited')
      const workspaceId = newId('ws').slice(0, 36)
      extraWorkspaceIds.add(workspaceId)
      await database.insert(workspaces).values({
        id: workspaceId,
        name: 'Invite Co',
        slug: `invite-${workspaceId.slice(-8)}`,
      })
      const inviteToken = generateInviteToken()
      tokensSeen.push(inviteToken)
      await database.insert(invites).values({
        id: newId('inv').slice(0, 36),
        workspaceId,
        email: address,
        role: 'member',
        tokenHash: hashInviteToken(inviteToken),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      })
      await clearSentMail()
      const accepted = await acceptInviteWithNewAccount(inviteToken, async (invited) => {
        const response = await authApi.signUpEmail({
          body: { email: invited, name: 'Invited', password: PASSWORD },
        })
        return { userId: response.user.id, result: response }
      })
      assert.equal(accepted.ok, true)
      await drainMail()
      const user = await userByEmail(address)
      assert.ok(user)
      assert.equal(user.emailVerified, true)
      assert.equal(await pendingFor(user.id), null)
      assert.equal((await verifiedEvents(user.id)).length, 0)
      assert.equal(
        sentMail.some((message) => message.text.includes('/verify-email?token=')),
        false,
      )
    } finally {
      process.env.HITLY_SIGNUP_ENABLED = previous
    }
  })

  it('confirmed email change still sets the flag itself and does not write email_verified', async () => {
    const { address, user, token } = await createUser('change-old')
    const next = email('change-new')
    const cookie = await signInCookie(address)
    await clearSentMail()
    const started = await handleEmailChange(
      new Request(`${APP_URL}/api/session/change-email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_URL, cookie },
        body: JSON.stringify({ currentPassword: PASSWORD, newEmail: next }),
      }),
      {
        log: () => {},
        allow: () => true,
        sendVerification: createSendEmailChangeVerification(APP_URL, sendMail, { track: trackChangeMail }),
        sendChangedNotice: createSendEmailChangedNotice(sendMail, { track: trackChangeMail }),
      },
    )
    assert.equal(started.status, 200)
    await drainMail()
    const changeToken = sentMail[0]?.text.match(/[?&]token=([A-Za-z0-9_-]{43})/)?.[1]
    assert.ok(changeToken)
    tokensSeen.push(changeToken)
    const confirmed = await handleEmailChangeVerify(changeToken, {
      log: () => {},
      sendChangedNotice: createSendEmailChangedNotice(sendMail, { track: trackChangeMail }),
    })
    assert.equal(confirmed.status, 200)
    const moved = await userByEmail(next)
    assert.ok(moved)
    assert.equal(moved.emailVerified, true)
    assert.equal(moved.id, user.id)
    assert.equal((await verifiedEvents(user.id)).length, 0)
    assert.equal(await pendingFor(user.id), null, 'email change drops open sign-up tokens')
    const stale = await errorOf(token)
    assert.deepEqual(stale, { status: 400, body: { error: 'invalid_token' } })
    assert.equal((await userByEmail(next))?.emailVerified, true, 'rejecting the old sign-up token does not change the flag')
    assert.equal(await userByEmail(address), null)
  })

  it('rejects a token stored for a different address without setting the flag', async () => {
    const { address, user, token } = await createUser('bound')
    await database
      .update(pendingEmailVerifications)
      .set({ email: email('other-inbox') })
      .where(eq(pendingEmailVerifications.userId, user.id))
    const rejected = await errorOf(token)
    assert.deepEqual(rejected, { status: 400, body: { error: 'invalid_token' } })
    assert.equal((await userByEmail(address))?.emailVerified, false)
    assert.equal((await verifiedEvents(user.id)).length, 0)
    assert.equal((await pendingFor(user.id))?.tokenHash, hashEmailVerificationToken(token))
  })

  it('one of eight concurrent confirms succeeds and writes a single email_verified event', async () => {
    const { address, user, token } = await createUser('race')
    await pool!.query(`
      CREATE OR REPLACE FUNCTION hitly_test_slow_verify_user()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.email_verified = true AND OLD.email_verified = false AND NEW.email = '${address}' THEN
          PERFORM pg_sleep(0.4);
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await pool!.query(`
      DROP TRIGGER IF EXISTS hitly_test_slow_verify_user ON users;
      CREATE TRIGGER hitly_test_slow_verify_user
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION hitly_test_slow_verify_user()
    `)
    try {
      const { POST } = await import('../app/api/session/verify-email/route')
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          POST(
            new NextRequest(`${APP_URL}${VERIFY_EMAIL_ENDPOINT}`, {
              method: 'POST',
              headers: { origin: APP_URL, 'content-type': 'application/json' },
              body: JSON.stringify({ token }),
            }),
          ),
        ),
      )
      const statuses = responses.map((response) => response.status).sort((a, b) => a - b)
      assert.deepEqual(statuses, [200, 400, 400, 400, 400, 400, 400, 400])
      assert.equal((await userByEmail(address))?.emailVerified, true)
      assert.equal(await pendingFor(user.id), null)
      assert.equal((await verifiedEvents(user.id)).length, 1)
    } finally {
      await pool!.query('DROP TRIGGER IF EXISTS hitly_test_slow_verify_user ON users')
      await pool!.query('DROP FUNCTION IF EXISTS hitly_test_slow_verify_user()')
    }
  })

  it('sign-up still succeeds when verification token storage fails', async () => {
    const address = email('storage-fail')
    await pool!.query(`
      CREATE OR REPLACE FUNCTION hitly_test_block_signup_verify()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND email = '${address}') THEN
          RAISE EXCEPTION 'signup verification storage failed';
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await pool!.query(`
      DROP TRIGGER IF EXISTS hitly_test_block_signup_verify ON pending_email_verifications;
      CREATE TRIGGER hitly_test_block_signup_verify
      BEFORE INSERT ON pending_email_verifications
      FOR EACH ROW EXECUTE FUNCTION hitly_test_block_signup_verify()
    `)
    try {
      await clearSentMail()
      const response = (await authApi.signUpEmail({
        body: { email: address, name: 'Alex', password: PASSWORD },
        asResponse: true,
      })) as unknown as Response
      assert.equal(response.status, 200)
      await drainMail()
      const user = await userByEmail(address)
      assert.ok(user)
      assert.equal(user.emailVerified, false)
      assert.equal(await pendingFor(user.id), null)
      assert.equal(sentMail.length, 0)
      assert.equal(await signInStatus(address), 200)
    } finally {
      await pool!.query('DROP TRIGGER IF EXISTS hitly_test_block_signup_verify ON pending_email_verifications')
      await pool!.query('DROP FUNCTION IF EXISTS hitly_test_block_signup_verify()')
    }
  })
})

describe('verification route policy', () => {
  it('refuses cross-site and non-JSON requests without consuming a token', async () => {
    const { user, token } = await createUser('policy')
    const { POST } = await import('../app/api/session/verify-email/route')
    const crossSite = new NextRequest(`${APP_URL}${VERIFY_EMAIL_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3002', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal((await POST(crossSite)).status, 403)
    const wrongType = new NextRequest(`${APP_URL}${VERIFY_EMAIL_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'text/plain' },
      body: JSON.stringify({ token }),
    })
    assert.equal((await POST(wrongType)).status, 415)
    assert.ok(await pendingFor(user.id))

    const { POST: resend } = await import('../app/api/session/resend-email-verification/route')
    const resendCross = new NextRequest(`${APP_URL}${RESEND_EMAIL_VERIFICATION_ENDPOINT}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3002', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal((await resend(resendCross)).status, 403)
  })
})

describe('resend limit', () => {
  it('allows 5 resends per client per 15 minutes and refuses the next', () => {
    assert.equal(RESEND_EMAIL_VERIFICATION_LIMIT, 5)
    assert.equal(RESEND_EMAIL_VERIFICATION_WINDOW_MS, 15 * 60 * 1000)
    const clock = { t: 1_000 }
    const allow = createResendEmailVerificationLimiter({ now: () => clock.t })
    for (let n = 0; n < 5; n += 1) assert.equal(allow('client'), true, `attempt ${n + 1} is inside the limit`)
    assert.equal(allow('client'), false, 'the 6th resend in the window is refused')
    assert.equal(allow('other'), true, 'another client has its own window')
    clock.t += RESEND_EMAIL_VERIFICATION_WINDOW_MS
    assert.equal(allow('client'), true, 'the window opens again after 15 minutes')
  })
})

describe('verification wiring', () => {
  it('the confirm page is public, sends no-referrer, and does not consume on GET', () => {
    assert.ok(PUBLIC_PATHS.includes(VERIFY_EMAIL_PAGE))
    const page = fs.readFileSync(path.join(__dirname, '../app/verify-email/page.tsx'), 'utf-8')
    assert.match(page, /referrer:\s*'no-referrer'/)
    assert.ok(page.includes('<ConfirmEmailVerificationForm'))
    assert.ok(!page.includes('handleEmailVerificationConfirm'))
    const config = fs.readFileSync(path.join(__dirname, '../next.config.mjs'), 'utf-8')
    assert.ok(config.includes("source: '/verify-email'"))
    const authSource = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8')
    assert.ok(!/emailVerification\s*:/.test(authSource))
    assert.ok(!authSource.includes('requireEmailVerification'))
    assert.ok(authSource.includes('issueEmailVerification'))
    assert.ok(authSource.includes('currentInviteSignup'))
    const profile = fs.readFileSync(path.join(__dirname, '../app/settings/profile/page.tsx'), 'utf-8')
    const security = fs.readFileSync(path.join(__dirname, '../app/settings/security/page.tsx'), 'utf-8')
    assert.ok(profile.includes('<UnverifiedEmailNotice'))
    assert.ok(security.includes('<UnverifiedEmailNotice'))
  })

  it('tokens are 256-bit and are not written to logs', () => {
    const token = generateEmailVerificationToken()
    tokensSeen.push(token)
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.equal(hashEmailVerificationToken(token).length, 64)
    const all = logged.join('\n')
    for (const seen of tokensSeen) {
      assert.ok(!all.includes(seen), 'token must not be logged')
      assert.ok(!all.includes(hashEmailVerificationToken(seen)), 'token hash must not be logged')
    }
  })
})
