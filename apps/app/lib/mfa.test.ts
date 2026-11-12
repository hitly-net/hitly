/**
 * Account MFA against real Postgres and the app's real Better Auth instance:
 * enrol (password + confirm), login second step, recovery codes, lockout,
 * replay, ciphertext-at-rest, and no secrets in logs.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'
process.env.HITLY_SIGNUP_ENABLED = '1'
process.env.HITLY_MFA_ENCRYPTION_KEY ??= 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, inArray, like } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@hitly/db/schema'
import {
  accountSecurityEvents,
  accounts,
  memberships,
  sessions,
  userMfa,
  userMfaRecoveryCodes,
  users,
  workspaces,
} from '@hitly/db/schema'
import { auth } from './auth'
import { db, pool } from './db'
import { createAppPool } from './db-pool'
import { CURRENT_PASSWORD_INCORRECT_MESSAGE } from './password-change'
import { PUBLIC_PATHS } from './constants'
import { newId } from './ids'
import { createRateLimiter } from './reset-check-limit'
import {
  MFA_CHALLENGE_COOKIE,
  MFA_CONFIRM_ENDPOINT,
  MFA_DISABLE_ENDPOINT,
  MFA_ENROL_ENDPOINT,
  MFA_RECOVERY_CODES_ENDPOINT,
  MFA_VERIFY_ENDPOINT,
  MFA_VERIFY_PAGE,
  submitMfaEnrol,
} from './mfa'
import {
  ACCOUNT_SECURITY_EVENT,
  getMfaStatus,
  handleMfaConfirm,
  handleMfaDisable,
  handleMfaEnrol,
  handleMfaRecoveryCodes,
  handleMfaVerify,
  hashMfaChallengeToken,
  MFA_DISABLED_LOG,
  MFA_OTHER_SESSIONS_REVOKED_LOG,
  MFA_RECOVERY_CODES_REGENERATED_LOG,
  type MfaRouteDeps,
} from './mfa-route'
import {
  holdPasswordSignInIfMfa,
  isSignInHeld,
  mountedEndpointKey,
  SESSION_ROUTE_POLICY,
  type SessionRouteKey,
} from './mfa-sign-in'
import { fromBase32, hashRecoveryCode, resolveMfaEncryptionKey, totpCode } from './mfa-crypto'
import { MFA_VERIFY_FAILURE_LIMIT } from './mfa-limit'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `mfa-${run}.example.com`
const PASSWORD = 'correct-horse-battery'
const NOW = 1_700_000_030_000

const logged: string[] = []
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

async function userByEmail(address: string) {
  const rows = await database.select().from(users).where(eq(users.email, address.toLowerCase())).limit(1)
  return rows[0] ?? null
}

function post(endpoint: string, cookie: string | undefined, body: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_URL,
    ...extra,
  }
  if (cookie) headers.cookie = cookie
  return new Request(`${APP_URL}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function routeMocks(overrides: Partial<MfaRouteDeps> = {}): MfaRouteDeps {
  return { log: () => {}, now: () => NOW, allowReauth: () => true, allowVerify: () => true, ...overrides }
}

const STEP_MS = 30_000

function totpAt(secret: string, steps = 1) {
  return totpCode(fromBase32(secret), NOW + steps * STEP_MS)
}

function mocksAt(steps = 1, overrides: Partial<MfaRouteDeps> = {}): MfaRouteDeps {
  return routeMocks({ now: () => NOW + steps * STEP_MS, ...overrides })
}

async function enableMfa(address: string, deps: MfaRouteDeps = routeMocks()) {
  await createUser(address)
  const cookie = await signInCookie(address)
  const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookie, { currentPassword: PASSWORD }), deps)
  const payload = (await enrolled.json()) as { secret: string; recoveryCodes: string[]; otpauthUri: string }
  const totp = totpCode(fromBase32(payload.secret), NOW)
  const confirmed = await handleMfaConfirm(post(MFA_CONFIRM_ENDPOINT, cookie, { code: totp }), deps)
  assert.equal(confirmed.status, 200)
  const user = await userByEmail(address)
  assert.ok(user)
  return {
    cookie,
    secret: payload.secret,
    recoveryCodes: payload.recoveryCodes,
    otpauthUri: payload.otpauthUri,
    totp,
    user,
  }
}

async function sessionFromCookie(cookie: string) {
  return authApi.getSession({ headers: new Headers({ cookie, origin: APP_URL }) })
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
    await database.delete(memberships).where(inArray(memberships.userId, ids))
    await database.delete(sessions).where(inArray(sessions.userId, ids))
    await database.delete(accounts).where(inArray(accounts.userId, ids))
  }
  const wsIds = owned.map((row) => row.id)
  if (wsIds.length) await database.delete(workspaces).where(inArray(workspaces.id, wsIds))
  if (ids.length) await database.delete(users).where(inArray(users.id, ids))
  await pool?.end()
})

describe('MFA enrolment', () => {
  it('enrols after a current-password check, stores ciphertext, and activates on a valid code', async () => {
    const address = email('enrol-ok')
    await createUser(address)
    const cookie = await signInCookie(address)
    const user = await userByEmail(address)
    assert.ok(user)

    const missing = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookie, { currentPassword: '' }), routeMocks())
    assert.equal(missing.status, 400)

    const wrong = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookie, { currentPassword: 'not-the-password' }), routeMocks())
    assert.equal(wrong.status, 400)
    assert.deepEqual(await wrong.json(), { code: 'INVALID_PASSWORD' })
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id))).length, 0)

    const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookie, { currentPassword: PASSWORD }), routeMocks())
    assert.equal(enrolled.status, 200)
    const payload = (await enrolled.json()) as {
      otpauthUri: string
      qrSvg: string
      secret: string
      recoveryCodes: string[]
    }
    assert.match(payload.otpauthUri, /^otpauth:\/\/totp\//)
    assert.match(payload.qrSvg, /<svg/)
    assert.equal(payload.recoveryCodes.length, 10)
    const secret = payload.secret
    const recoveryCodes = payload.recoveryCodes

    const stored = await database.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1)
    assert.equal(stored[0]?.enabled, false)
    assert.ok(!stored[0]!.totpCiphertext.includes(secret))
    const hashes = await database.select().from(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, user.id))
    const serialised = JSON.stringify(hashes)
    for (const code of recoveryCodes) {
      assert.ok(!serialised.includes(code), 'recovery codes are not stored in plain text')
    }

    const badConfirm = await handleMfaConfirm(post(MFA_CONFIRM_ENDPOINT, cookie, { code: '000000' }), routeMocks())
    assert.equal(badConfirm.status, 400)
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]?.enabled, false)

    const code = totpCode(fromBase32(secret), NOW)
    const confirmed = await handleMfaConfirm(post(MFA_CONFIRM_ENDPOINT, cookie, { code }), routeMocks())
    assert.equal(confirmed.status, 200)
    assert.deepEqual(await confirmed.json(), { ok: true })
    const after = await getMfaStatus(user.id, routeMocks())
    assert.deepEqual(after, { enabled: true, pending: false, recoveryCodesRemaining: 10 })

    const replay = await handleMfaConfirm(post(MFA_CONFIRM_ENDPOINT, cookie, { code }), routeMocks())
    assert.equal(replay.status, 409)

    const events = await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))
    assert.ok(events.some((event) => event.type === ACCOUNT_SECURITY_EVENT.enrolled))

    const joinedLogs = logged.join('\n')
    assert.ok(!joinedLogs.includes(secret), 'TOTP secret must not appear in logs')
    assert.ok(!joinedLogs.includes(payload.otpauthUri), 'otpauth URI must not appear in logs')
    for (const recovery of recoveryCodes) {
      assert.ok(!joinedLogs.includes(recovery), 'recovery codes must not appear in logs')
    }
    assert.ok(!joinedLogs.includes(code), 'TOTP code must not appear in logs')
  })
})

describe('MFA confirm revokes other sessions', () => {
  it('revokes other sessions on a successful confirm and keeps the current session', async () => {
    const address = email('confirm-revoke')
    await createUser(address)
    const cookieA = await signInCookie(address)
    const cookieB = await signInCookie(address)
    assert.ok(await sessionFromCookie(cookieA))
    assert.ok(await sessionFromCookie(cookieB))

    const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookieA, { currentPassword: PASSWORD }), routeMocks())
    const payload = (await enrolled.json()) as { secret: string }
    const lines: string[] = []
    const confirmed = await handleMfaConfirm(
      post(MFA_CONFIRM_ENDPOINT, cookieA, { code: totpCode(fromBase32(payload.secret), NOW) }),
      routeMocks({ log: (line) => lines.push(line) }),
    )
    assert.equal(confirmed.status, 200)
    assert.ok(await sessionFromCookie(cookieA), 'the current session is kept')
    assert.equal(await sessionFromCookie(cookieB), null, 'other sessions are revoked')

    const user = await userByEmail(address)
    assert.ok(user)
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(types.includes(ACCOUNT_SECURITY_EVENT.enrolled))
    assert.ok(types.includes(ACCOUNT_SECURITY_EVENT.otherSessionsRevoked))
    assert.deepEqual(lines, [`${MFA_OTHER_SESSIONS_REVOKED_LOG} user=${user.id}`])
  })

  it('does not revoke sessions when confirm fails', async () => {
    const address = email('confirm-keep')
    await createUser(address)
    const cookieA = await signInCookie(address)
    const cookieB = await signInCookie(address)
    const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookieA, { currentPassword: PASSWORD }), routeMocks())
    assert.equal(enrolled.status, 200)
    const failed = await handleMfaConfirm(post(MFA_CONFIRM_ENDPOINT, cookieA, { code: '000000' }), routeMocks())
    assert.equal(failed.status, 400)
    assert.ok(await sessionFromCookie(cookieA))
    assert.ok(await sessionFromCookie(cookieB), 'a failed confirm must not revoke other sessions')
    const user = await userByEmail(address)
    assert.ok(user)
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(!types.includes(ACCOUNT_SECURITY_EVENT.otherSessionsRevoked))
    assert.ok(!types.includes(ACCOUNT_SECURITY_EVENT.enrolled))
  })

  it('rolls back confirm when revokeOtherSessions throws, then a retry with a fresh code succeeds', async () => {
    const address = email('confirm-revoke-fail')
    await createUser(address)
    const cookieA = await signInCookie(address)
    const cookieB = await signInCookie(address)
    const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookieA, { currentPassword: PASSWORD }), routeMocks())
    const payload = (await enrolled.json()) as { secret: string }
    const user = await userByEmail(address)
    assert.ok(user)

    const failLines: string[] = []
    const failed = await handleMfaConfirm(
      post(MFA_CONFIRM_ENDPOINT, cookieA, { code: totpCode(fromBase32(payload.secret), NOW) }),
      routeMocks({
        log: (line) => failLines.push(line),
        revokeOtherSessions: async () => {
          throw new Error('revoke failed')
        },
      }),
    )
    assert.equal(failed.status, 500)
    assert.deepEqual(await failed.json(), { error: 'mfa_failed' })
    assert.deepEqual(failLines, ['[hitly mfa] Could not confirm MFA: Error'])
    const pending = (await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]
    assert.equal(pending?.enabled, false)
    assert.equal(pending?.lastUsedStep, null)
    const typesAfterFail = (
      await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))
    ).map((event) => event.type)
    assert.ok(!typesAfterFail.includes(ACCOUNT_SECURITY_EVENT.enrolled))
    assert.ok(!typesAfterFail.includes(ACCOUNT_SECURITY_EVENT.otherSessionsRevoked))
    assert.ok(await sessionFromCookie(cookieA))
    assert.ok(await sessionFromCookie(cookieB), 'other sessions stay valid when revoke fails')

    const retried = await handleMfaConfirm(
      post(MFA_CONFIRM_ENDPOINT, cookieA, { code: totpAt(payload.secret, 1) }),
      mocksAt(1),
    )
    assert.equal(retried.status, 200)
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]?.enabled, true)
    assert.ok(await sessionFromCookie(cookieA), 'the current session is kept')
    assert.equal(await sessionFromCookie(cookieB), null, 'other sessions are revoked on retry')
  })

  it('revokes every other session for the user and leaves a different user untouched', async () => {
    const address = email('confirm-three')
    const other = email('confirm-three-other')
    await createUser(address)
    await createUser(other)
    const cookieA = await signInCookie(address)
    const cookieB = await signInCookie(address)
    const cookieC = await signInCookie(address)
    const cookieD = await signInCookie(other)
    const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookieA, { currentPassword: PASSWORD }), routeMocks())
    const payload = (await enrolled.json()) as { secret: string }
    const confirmed = await handleMfaConfirm(
      post(MFA_CONFIRM_ENDPOINT, cookieA, { code: totpCode(fromBase32(payload.secret), NOW) }),
      routeMocks(),
    )
    assert.equal(confirmed.status, 200)
    assert.ok(await sessionFromCookie(cookieA), 'session A is kept')
    assert.equal(await sessionFromCookie(cookieB), null, 'session B is revoked')
    assert.equal(await sessionFromCookie(cookieC), null, 'session C is revoked')
    assert.ok(await sessionFromCookie(cookieD), 'user D is untouched')
  })

  it('confirm audit rows are named events with no TOTP secret, code, or encryption key', async () => {
    const address = email('confirm-audit')
    await createUser(address)
    const cookie = await signInCookie(address)
    const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookie, { currentPassword: PASSWORD }), routeMocks())
    const payload = (await enrolled.json()) as { secret: string }
    const code = totpCode(fromBase32(payload.secret), NOW)
    const confirmed = await handleMfaConfirm(post(MFA_CONFIRM_ENDPOINT, cookie, { code }), routeMocks())
    assert.equal(confirmed.status, 200)
    const user = await userByEmail(address)
    assert.ok(user)
    const events = await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))
    const allowed = new Set<string>(Object.values(ACCOUNT_SECURITY_EVENT))
    assert.ok(events.some((event) => event.type === ACCOUNT_SECURITY_EVENT.enrolled))
    assert.ok(events.some((event) => event.type === ACCOUNT_SECURITY_EVENT.otherSessionsRevoked))
    const wrappingKey = process.env.HITLY_MFA_ENCRYPTION_KEY ?? ''
    for (const event of events) {
      assert.ok(allowed.has(event.type), 'audit type must be an ACCOUNT_SECURITY_EVENT value')
      const serialised = JSON.stringify(event)
      assert.ok(!serialised.includes(payload.secret), 'audit must not contain the TOTP secret')
      assert.ok(!serialised.includes(code), 'audit must not contain the TOTP code')
      if (wrappingKey) assert.ok(!serialised.includes(wrappingKey), 'audit must not contain the encryption key')
    }
  })

  it('returns mfa_failed within a bounded time when the pool is exhausted', async () => {
    const address = email('confirm-pool')
    await createUser(address)
    const cookie = await signInCookie(address)
    const enrolled = await handleMfaEnrol(post(MFA_ENROL_ENDPOINT, cookie, { currentPassword: PASSWORD }), routeMocks())
    const payload = (await enrolled.json()) as { secret: string }
    const user = await userByEmail(address)
    assert.ok(user)
    const url = process.env.DATABASE_URL
    assert.ok(url)

    const tiny = createAppPool(url, {
      HITLY_DB_POOL_MAX: '1',
      HITLY_DB_CONNECTION_TIMEOUT_MS: '500',
    })
    assert.equal(tiny.options.connectionTimeoutMillis, 500)
    const tinyDb = drizzle(tiny, { schema })
    const failLines: string[] = []
    const started = Date.now()
    let cap: ReturnType<typeof setTimeout> | undefined
    try {
      const failed = await Promise.race([
        handleMfaConfirm(
          post(MFA_CONFIRM_ENDPOINT, cookie, { code: totpCode(fromBase32(payload.secret), NOW) }),
          routeMocks({
            database: tinyDb,
            log: (line) => failLines.push(line),
            revokeOtherSessions: async () => {
              const client = await tiny.connect()
              client.release()
            },
          }),
        ),
        new Promise<never>((_, reject) => {
          cap = setTimeout(() => reject(new Error('exhausted pool did not fail within 3000ms')), 3000)
        }),
      ])
      const elapsed = Date.now() - started
      assert.ok(elapsed < 3000, `exhausted pool must fail quickly, took ${elapsed}ms`)
      assert.equal(failed.status, 500)
      assert.deepEqual(await failed.json(), { error: 'mfa_failed' })
      assert.equal(failLines.length, 1)
      assert.match(failLines[0]!, /^\[hitly mfa\] Could not confirm MFA: /)
      assert.ok(!failLines[0]!.includes(payload.secret))
      assert.ok(!failLines[0]!.includes('postgres://'))
      const pending = (await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]
      assert.equal(pending?.enabled, false)
      const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
        (event) => event.type,
      )
      assert.ok(!types.includes(ACCOUNT_SECURITY_EVENT.enrolled))
      assert.ok(!types.includes(ACCOUNT_SECURITY_EVENT.otherSessionsRevoked))
    } finally {
      if (cap) clearTimeout(cap)
      await Promise.race([tiny.end(), new Promise((resolve) => setTimeout(resolve, 250))])
    }
  })
})

describe('MFA login second step', () => {
  it('blocks a full session until TOTP succeeds, and rejects a replayed code', async () => {
    const address = email('login-totp')
    const { secret, totp } = await enableMfa(address)
    const user = await userByEmail(address)
    assert.ok(user)

    const signIn = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    assert.equal(signIn.status, 200)
    const gated = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signIn,
      routeMocks(),
    )
    assert.equal(gated.status, 200)
    assert.deepEqual(await gated.json(), { mfaRequired: true })
    const setCookies = gated.headers.getSetCookie()
    assert.equal(
      setCookies.some((value) => value.startsWith('better-auth.session_token=') && !value.includes('Max-Age=0')),
      false,
      'half-auth must not issue a session cookie',
    )
    const challenge = setCookies.find((value) => value.startsWith(`${MFA_CHALLENGE_COOKIE}=`))
    assert.ok(challenge)
    const challengeCookie = challenge.split(';')[0]!
    assert.equal(await sessionFromCookie(challengeCookie), null)

    const protectedAttempt = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, challengeCookie, { currentPassword: PASSWORD }),
      routeMocks(),
    )
    assert.equal(protectedAttempt.status, 401)

    const replayAtLogin = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challengeCookie, { code: totp }), routeMocks())
    assert.equal(replayAtLogin.status, 400, 'the enrol-confirm code cannot be reused in the same window')

    const nextCode = totpCode(fromBase32(secret), NOW + 30_000)
    const verified = await handleMfaVerify(
      post(MFA_VERIFY_ENDPOINT, challengeCookie, { code: nextCode }),
      { ...routeMocks(), now: () => NOW + 30_000 },
    )
    assert.equal(verified.status, 200)
    const sessionCookie = verified.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .filter((value) => value.startsWith('better-auth.session_token=') || value.startsWith('__Secure-better-auth.session_token='))
      .join('; ')
    assert.ok(sessionCookie)
    const session = await sessionFromCookie(sessionCookie)
    assert.equal(session?.user.id, user.id)
  })

  it('accepts a recovery code once, then rejects it', async () => {
    const address = email('login-recovery')
    const { recoveryCodes } = await enableMfa(address)
    const signIn = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    const gated = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signIn,
      routeMocks(),
    )
    const challengeCookie = gated.headers.getSetCookie().find((value) => value.startsWith(`${MFA_CHALLENGE_COOKIE}=`))!.split(';')[0]!
    const code = recoveryCodes[0]!
    const first = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challengeCookie, { code }), routeMocks())
    assert.equal(first.status, 200)
    const user = await userByEmail(address)
    assert.ok(user)
    const events = await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))
    assert.ok(events.some((event) => event.type === ACCOUNT_SECURITY_EVENT.recoveryCodeUsed))

    const signInAgain = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    const gatedAgain = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signInAgain,
      routeMocks(),
    )
    const challenge2 = gatedAgain.headers.getSetCookie().find((value) => value.startsWith(`${MFA_CHALLENGE_COOKIE}=`))!.split(';')[0]!
    const second = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challenge2, { code }), routeMocks())
    assert.equal(second.status, 400)
  })

  it('trips the per-client limiter and the per-user lockout', async () => {
    const address = email('login-limit')
    const { secret } = await enableMfa(address)
    const user = await userByEmail(address)
    assert.ok(user)
    const signIn = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    const gated = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signIn,
      routeMocks(),
    )
    const challengeCookie = gated.headers.getSetCookie().find((value) => value.startsWith(`${MFA_CHALLENGE_COOKIE}=`))!.split(';')[0]!

    const limited = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challengeCookie, { code: '000000' }), {
      ...routeMocks(),
      allowVerify: () => false,
    })
    assert.equal(limited.status, 429)

    const signIn2 = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    const gated2 = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signIn2,
      routeMocks(),
    )
    const challenge2 = gated2.headers.getSetCookie().find((value) => value.startsWith(`${MFA_CHALLENGE_COOKIE}=`))!.split(';')[0]!
    for (let i = 0; i < MFA_VERIFY_FAILURE_LIMIT; i += 1) {
      const failed = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challenge2, { code: '000000' }), {
        ...routeMocks(),
        allowVerify: () => true,
      })
      assert.equal(failed.status, 400)
    }
    const valid = totpCode(fromBase32(secret), NOW + 30_000)
    const locked = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challenge2, { code: valid }), {
      ...routeMocks(),
      allowVerify: () => true,
      now: () => NOW + 30_000,
    })
    assert.equal(locked.status, 429)
    const events = await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))
    assert.ok(events.some((event) => event.type === ACCOUNT_SECURITY_EVENT.verificationLockout))
  })
})

describe('MFA disable and recovery regenerate', () => {
  it('refuses disable and regenerate with only the current password', async () => {
    const { cookie, user } = await enableMfa(email('factor-password-only'))
    const regen = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD }),
      mocksAt(1),
    )
    assert.equal(regen.status, 400)
    assert.deepEqual(await regen.json(), { error: 'invalid_code' })
    const disable = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD }),
      mocksAt(1),
    )
    assert.equal(disable.status, 400)
    assert.deepEqual(await disable.json(), { error: 'invalid_code' })
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]?.enabled, true)
  })

  it('refuses disable with a missing or wrong TOTP and counts the wrong code toward lockout', async () => {
    const { cookie, user } = await enableMfa(email('factor-wrong-totp'))
    const missing = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code: '' }),
      mocksAt(1),
    )
    assert.equal(missing.status, 400)
    const wrong = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code: '000000' }),
      mocksAt(1),
    )
    assert.equal(wrong.status, 400)
    assert.deepEqual(await wrong.json(), { error: 'invalid_code' })
    const row = (await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]
    assert.equal(row?.enabled, true)
    assert.equal(row?.failedVerifyCount, 1)
  })

  it('disables MFA with password and a valid TOTP', async () => {
    const { cookie, secret, user } = await enableMfa(email('disable-totp'))
    const disabled = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code: totpAt(secret, 1) }),
      mocksAt(1),
    )
    assert.equal(disabled.status, 200)
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id))).length, 0)
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(types.includes(ACCOUNT_SECURITY_EVENT.disabled))
  })

  it('disables MFA with password and an unused recovery code, which is consumed', async () => {
    const { cookie, recoveryCodes, user } = await enableMfa(email('disable-recovery'))
    const code = recoveryCodes[0]!
    const disabled = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code }),
      mocksAt(1),
    )
    assert.equal(disabled.status, 200)
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id))).length, 0)
    assert.equal((await database.select().from(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, user.id))).length, 0)
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(types.includes(ACCOUNT_SECURITY_EVENT.recoveryCodeUsed))
    assert.ok(types.includes(ACCOUNT_SECURITY_EVENT.disabled))
  })

  it('refuses a reused recovery code on disable', async () => {
    const { cookie, recoveryCodes, secret, user } = await enableMfa(email('disable-reuse'))
    const code = recoveryCodes[0]!
    const first = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code }),
      mocksAt(1),
    )
    assert.equal(first.status, 200)
    const reused = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code }),
      mocksAt(2),
    )
    assert.equal(reused.status, 400)
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]?.enabled, true)
    const disabled = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code: totpAt(secret, 2) }),
      mocksAt(2),
    )
    assert.equal(disabled.status, 200)
  })

  it('regenerates recovery codes with password and a valid TOTP', async () => {
    const { cookie, secret, recoveryCodes, user } = await enableMfa(email('regen-totp'))
    const regen = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code: totpAt(secret, 1) }),
      mocksAt(1),
    )
    assert.equal(regen.status, 200)
    const body = (await regen.json()) as { recoveryCodes: string[] }
    assert.equal(body.recoveryCodes.length, 10)
    assert.ok(!body.recoveryCodes.includes(recoveryCodes[0]!))
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(types.includes(ACCOUNT_SECURITY_EVENT.recoveryCodesRegenerated))
  })

  it('regenerates recovery codes with password and an unused recovery code, which is consumed', async () => {
    const { cookie, recoveryCodes, user } = await enableMfa(email('regen-recovery'))
    const code = recoveryCodes[0]!
    const regen = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code }),
      mocksAt(1),
    )
    assert.equal(regen.status, 200)
    const body = (await regen.json()) as { recoveryCodes: string[] }
    assert.equal(body.recoveryCodes.length, 10)
    assert.ok(!body.recoveryCodes.includes(code))
    const unused = await database
      .select()
      .from(userMfaRecoveryCodes)
      .where(and(eq(userMfaRecoveryCodes.userId, user.id), eq(userMfaRecoveryCodes.codeHash, hashRecoveryCode(code, resolveMfaEncryptionKey()))))
    assert.equal(unused.length, 0)
  })

  it('refuses a reused recovery code on regenerate', async () => {
    const { cookie, recoveryCodes } = await enableMfa(email('regen-reuse'))
    const code = recoveryCodes[0]!
    const first = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code }),
      mocksAt(1),
    )
    assert.equal(first.status, 200)
    const reused = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code }),
      mocksAt(2),
    )
    assert.equal(reused.status, 400)
    assert.deepEqual(await reused.json(), { error: 'invalid_code' })
  })

  it('applies the login MFA verify rate limit and lockout to disable and regenerate', async () => {
    const { cookie, secret, user } = await enableMfa(email('factor-limit'))
    const limitedDisable = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code: totpAt(secret, 1) }),
      mocksAt(1, { allowVerify: () => false }),
    )
    assert.equal(limitedDisable.status, 429)
    assert.equal((await database.select().from(userMfa).where(eq(userMfa.userId, user.id)))[0]?.enabled, true)

    const limitedRegen = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code: totpAt(secret, 1) }),
      mocksAt(1, { allowVerify: () => false }),
    )
    assert.equal(limitedRegen.status, 429)

    for (let i = 0; i < MFA_VERIFY_FAILURE_LIMIT; i += 1) {
      const failed = await handleMfaRecoveryCodes(
        post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code: '000000' }),
        mocksAt(1),
      )
      assert.equal(failed.status, 400)
    }
    const locked = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code: totpAt(secret, 1) }),
      mocksAt(1),
    )
    assert.equal(locked.status, 429)
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(types.includes(ACCOUNT_SECURITY_EVENT.verificationLockout))
  })
})

describe('MFA secrets stay out of logs', () => {
  it('deps.log and console never receive TOTP secrets, codes, recovery codes, otpauth URIs or hashes across enrol, confirm, verify, disable and recovery-codes', async () => {
    const lines: string[] = []
    const deps = routeMocks({ log: (line) => lines.push(line) })
    const address = email('log-capture')
    const { cookie, secret, recoveryCodes, otpauthUri, totp, user } = await enableMfa(address, deps)
    const master = resolveMfaEncryptionKey()
    const recoveryHashes = recoveryCodes.map((code) => hashRecoveryCode(code, master))
    const stored = await database.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1)
    const ciphertext = stored[0]?.totpCiphertext ?? ''

    const signIn = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    const gated = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signIn,
      deps,
    )
    const challengeHeader = gated.headers.getSetCookie().find((value) => value.startsWith(`${MFA_CHALLENGE_COOKIE}=`))!
    const challengeToken = decodeURIComponent(challengeHeader.split(';')[0]!.slice(`${MFA_CHALLENGE_COOKIE}=`.length))
    const challengeHash = hashMfaChallengeToken(challengeToken)
    const nextCode = totpAt(secret, 1)
    const verified = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challengeHeader.split(';')[0]!, { code: nextCode }), {
      ...deps,
      now: () => NOW + STEP_MS,
    })
    assert.equal(verified.status, 200)

    const regenCode = totpAt(secret, 2)
    const regen = await handleMfaRecoveryCodes(
      post(MFA_RECOVERY_CODES_ENDPOINT, cookie, { currentPassword: PASSWORD, code: regenCode }),
      { ...deps, now: () => NOW + 2 * STEP_MS },
    )
    assert.equal(regen.status, 200)
    const fresh = ((await regen.json()) as { recoveryCodes: string[] }).recoveryCodes
    const disableCode = totpAt(secret, 3)
    const disabled = await handleMfaDisable(
      post(MFA_DISABLE_ENDPOINT, cookie, { currentPassword: PASSWORD, code: disableCode }),
      { ...deps, now: () => NOW + 3 * STEP_MS },
    )
    assert.equal(disabled.status, 200)

    const joined = `${lines.join('\n')}\n${logged.join('\n')}`
    const longSecrets = [
      secret,
      otpauthUri,
      challengeToken,
      challengeHash,
      ciphertext,
      ...recoveryCodes,
      ...recoveryHashes,
      ...fresh,
      ...fresh.map((code) => hashRecoveryCode(code, master)),
    ]
    for (const value of longSecrets) {
      if (!value) continue
      assert.ok(!joined.includes(value), 'MFA secret must not appear in deps.log or console')
    }
    const capturedLog = lines.join('\n')
    for (const value of [totp, nextCode, regenCode, disableCode]) {
      assert.ok(!capturedLog.includes(value), 'deps.log must not receive the raw TOTP code')
    }
    assert.ok(
      lines.some((line) => line.startsWith(MFA_DISABLED_LOG) && line.includes(`user=${user.id}`)),
      'disable auth-log event name plus user id',
    )
    assert.ok(
      lines.some((line) => line.startsWith(MFA_RECOVERY_CODES_REGENERATED_LOG) && line.includes(`user=${user.id}`)),
      'regenerate auth-log event name plus user id',
    )
    for (const line of lines) {
      assert.ok(!line.includes(secret) && !line.includes(otpauthUri))
      assert.match(line, /^\[hitly mfa]/)
      if (line.startsWith(MFA_DISABLED_LOG) || line.startsWith(MFA_RECOVERY_CODES_REGENERATED_LOG)) {
        assert.equal(line, `${line.startsWith(MFA_DISABLED_LOG) ? MFA_DISABLED_LOG : MFA_RECOVERY_CODES_REGENERATED_LOG} user=${user.id}`)
      }
    }
  })
})

describe('MFA client helpers and static wiring', () => {
  it('maps INVALID_PASSWORD through the shared current-password message', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 'INVALID_PASSWORD' }), { status: 400, headers: { 'content-type': 'application/json' } })
    const outcome = await submitMfaEnrol('x', fake)
    assert.deepEqual(outcome, { ok: false, message: CURRENT_PASSWORD_INCORRECT_MESSAGE })
  })

  it('the security page renders MfaSetup and /login/mfa is public', () => {
    const page = fs.readFileSync(path.join(__dirname, '../app/settings/security/page.tsx'), 'utf-8')
    assert.ok(page.includes('<MfaSetup'))
    assert.ok(page.includes('getMfaStatus'))
    assert.ok(PUBLIC_PATHS.some((pathName) => MFA_VERIFY_PAGE === pathName || MFA_VERIFY_PAGE.startsWith(`${pathName}/`)))
    const proxy = fs.readFileSync(path.join(__dirname, '../proxy.ts'), 'utf-8')
    assert.ok(proxy.includes('better-auth.session_token'))
    assert.ok(!proxy.includes(MFA_CHALLENGE_COOKIE), 'the half-auth cookie is not a session')
    const passwordChange = fs.readFileSync(path.join(__dirname, 'password-change-route.ts'), 'utf-8')
    const emailChange = fs.readFileSync(path.join(__dirname, 'email-change-route.ts'), 'utf-8')
    assert.ok(passwordChange.includes('verifyPassword') || passwordChange.includes('changePassword'))
    assert.ok(emailChange.includes('verifyPassword'))
    for (const name of ['disable', 'recovery-codes'] as const) {
      const route = fs.readFileSync(path.join(__dirname, `../app/api/session/mfa/${name}/route.ts`), 'utf-8')
      assert.ok(route.includes('isSameOrigin'))
    }
  })

  it('per-user and per-IP keys are both consumed by the verify limiter', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => NOW })
    assert.equal(limiter('user:1'), true)
    assert.equal(limiter('ip:a'), true)
    assert.equal(limiter('user:1'), false)
    assert.equal(limiter('ip:a'), false)
  })
})

/**
 * Routes that set a session cookie but are not new sign-ins. A Better Auth
 * upgrade that adds another createSession / setSessionCookie route fails the
 * coverage test until it is held or added here on purpose.
 */
const SESSION_WRITE_EXEMPT = new Set([
  'GET /get-session',
  'POST /get-session',
  'POST /update-session',
  'POST /update-user',
  'POST /change-password',
  'POST /change-email',
])

function sessionWritingRoutes(source: string): Array<{ path: string; methods: string[] }> {
  const found: Array<{ path: string; methods: string[] }> = []
  for (const chunk of source.split(/createAuthEndpoint(?:\.serverOnly)?\(/).slice(1)) {
    const pathMatch = chunk.match(/^\s*["']([^"']+)["']/)
    if (!pathMatch) continue
    if (!chunk.includes('createSession') && !chunk.includes('setSessionCookie')) continue
    const head = chunk.slice(0, 600)
    const methodMatch = head.match(/method:\s*(\[[^\]]+\]|"[^"]+")/)
    const methods = !methodMatch
      ? []
      : methodMatch[1].startsWith('[')
        ? [...methodMatch[1].matchAll(/["']([A-Z]+)["']/g)].map((match) => match[1]!)
        : [methodMatch[1].replace(/"/g, '')]
    found.push({ path: pathMatch[1]!, methods })
  }
  return found
}

function challengeCookieOf(response: Response): string {
  const raw = response.headers.getSetCookie().find((value) => value.startsWith(`${MFA_CHALLENGE_COOKIE}=`))
  assert.ok(raw, 'expected a challenge cookie')
  return raw.split(';')[0]!
}

function forwardsSessionCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((value) => {
    const pair = value.split(';')[0]?.trim() ?? ''
    return /^(?:__Secure-)?better-auth\.session_token=.+/.test(pair) && !/max-age=0/i.test(value)
  })
}

async function responseWithSession(address: string, status: number, extra: Record<string, string> = {}) {
  const signIn = (await authApi.signInEmail({
    body: { email: address, password: PASSWORD },
    asResponse: true,
  })) as unknown as Response
  assert.equal(signIn.status, 200)
  const headers = new Headers(extra)
  for (const cookie of signIn.headers.getSetCookie()) headers.append('set-cookie', cookie)
  const body = status >= 300 && status < 400 ? null : await signIn.text()
  return new Response(body, { status, headers })
}

describe('MFA hold covers every session-minting sign-in', () => {
  it('classifies every mounted auth route, and a new session-writing route cannot skip the hold', () => {
    assert.ok(auth)
    const mounted: string[] = []
    for (const [name, endpoint] of Object.entries(auth.api)) {
      if (typeof endpoint !== 'function') continue
      const fn = endpoint as { path?: string; options?: { method?: string | string[] } }
      const method = fn.options?.method
      const methods = Array.isArray(method) ? method : method ? [method] : []
      assert.ok(methods.length > 0, `${name} has no method`)
      for (const verb of methods) mounted.push(mountedEndpointKey(name, fn.path, verb))
    }
    mounted.sort()
    const policyMounted = (Object.entries(SESSION_ROUTE_POLICY) as Array<[string, { mounted: boolean }]> )
      .filter(([, policy]) => policy.mounted)
      .map(([key]) => key)
      .sort()
    assert.deepEqual(mounted, policyMounted)

    const route = fs.readFileSync(path.join(__dirname, '../app/api/auth/[...all]/route.ts'), 'utf8')
    const getFn = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'))
    const postFn = route.slice(route.indexOf('export async function POST'))
    assert.match(getFn, /return holdPasswordSignInIfMfa\(request, response\)/)
    assert.match(postFn, /return holdPasswordSignInIfMfa\(request, response\)/)

    for (const [key, policy] of Object.entries(SESSION_ROUTE_POLICY) as Array<[SessionRouteKey, (typeof SESSION_ROUTE_POLICY)[SessionRouteKey]]>) {
      if (key.includes('server-only')) {
        assert.equal(policy.action, 'not-sign-in')
        continue
      }
      const method = key.slice(0, key.indexOf(' '))
      const routePath = key.slice(method.length + 1).replace(':id', 'google').replace(':providerId', 'example').replace(':token', 'token')
      const request = new Request(`${APP_URL}/api/auth${routePath}`, { method })
      if (policy.action === 'hold') assert.equal(isSignInHeld(request), true, key)
      else assert.equal(isSignInHeld(request), false, key)
    }

    const root = path.join(__dirname, '../../..')
    const files = [
      ...fs.readdirSync(path.join(root, 'node_modules/better-auth/dist/api/routes')).map((name) =>
        path.join(root, 'node_modules/better-auth/dist/api/routes', name),
      ),
      path.join(root, 'node_modules/@better-auth/passkey/dist/index.mjs'),
    ]
    for (const file of files) {
      if (!file.endsWith('.mjs')) continue
      for (const found of sessionWritingRoutes(fs.readFileSync(file, 'utf8'))) {
        assert.ok(found.methods.length > 0, found.path)
        for (const method of found.methods) {
          const key = `${method} ${found.path}`
          const policy = SESSION_ROUTE_POLICY[key as SessionRouteKey]
          assert.ok(policy, `${key} writes a session but is not in SESSION_ROUTE_POLICY`)
          if (policy.action === 'not-sign-in') {
            assert.ok(SESSION_WRITE_EXEMPT.has(key), `${key} writes a session cookie and is not held`)
          } else {
            assert.ok(policy.action === 'hold' || policy.action === 'uv-satisfies-mfa', key)
          }
        }
      }
    }
  })

  it('leaves a failed password sign-in untouched', async () => {
    const failed = new Response(JSON.stringify({ message: 'Invalid email or password' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
    const held = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      failed,
      routeMocks(),
    )
    assert.equal(held, failed)
  })

  it('forwards sign-up, the OAuth callback, and social id-token sign-in unchanged when MFA is off', async () => {
    const address = email('hold-off')
    await createUser(address)
    const signUp = await responseWithSession(address, 200, { 'content-type': 'application/json' })
    const heldSignUp = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-up/email`, { method: 'POST' }),
      signUp,
      routeMocks(),
    )
    assert.equal(heldSignUp, signUp)

    const callback = await responseWithSession(address, 302, { location: `${APP_URL}/inbox` })
    const heldCallback = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/callback/google`, { method: 'GET' }),
      callback,
      routeMocks(),
    )
    assert.equal(heldCallback, callback)

    const social = await responseWithSession(address, 200, { 'content-type': 'application/json' })
    const heldSocial = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/social`, { method: 'POST' }),
      social,
      routeMocks(),
    )
    assert.equal(heldSocial, social)
  })

  it('does not hold session refresh or password change', async () => {
    const { user } = await enableMfa(email('hold-refresh'))
    const refresh = await responseWithSession(user.email, 200, { 'content-type': 'application/json' })
    const heldRefresh = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/get-session`, { method: 'GET' }),
      refresh,
      routeMocks(),
    )
    assert.equal(heldRefresh, refresh)
    assert.equal(forwardsSessionCookie(heldRefresh), true)

    const changed = await responseWithSession(user.email, 200, { 'content-type': 'application/json' })
    const heldChange = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/change-password`, { method: 'POST' }),
      changed,
      routeMocks(),
    )
    assert.equal(heldChange, changed)
  })

  it('holds an OAuth callback when TOTP is enrolled and finishes on /login/mfa', async () => {
    const address = email('hold-callback')
    await enableMfa(address)
    const callback = await responseWithSession(address, 302, { location: `${APP_URL}/inbox` })
    const held = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/callback/google`, { method: 'GET' }),
      callback,
      routeMocks(),
    )
    assert.notEqual(held, callback)
    assert.equal(held.status, 302)
    assert.equal(new URL(held.headers.get('location') ?? '').pathname, '/login/mfa')
    assert.equal(forwardsSessionCookie(held), false)
    assert.ok(challengeCookieOf(held))
  })

  it('holds social id-token, generic OAuth, and magic-link verify with the same challenge', async () => {
    const address = email('hold-seams')
    await enableMfa(address)
    for (const [method, routePath, status] of [
      ['POST', '/sign-in/social', 200],
      ['GET', '/oauth2/callback/example', 302],
      ['GET', '/magic-link/verify', 302],
      ['POST', '/sign-in/email-otp', 200],
    ] as const) {
      const minted = await responseWithSession(
        address,
        status,
        status === 302 ? { location: `${APP_URL}/inbox` } : { 'content-type': 'application/json' },
      )
      const held = await holdPasswordSignInIfMfa(
        new Request(`${APP_URL}/api/auth${routePath}`, { method }),
        minted,
        routeMocks(),
      )
      assert.equal(forwardsSessionCookie(held), false, routePath)
      assert.ok(challengeCookieOf(held), routePath)
      if (status === 302) assert.equal(new URL(held.headers.get('location') ?? '').pathname, '/login/mfa')
      else assert.deepEqual(await held.json(), { mfaRequired: true })
    }
  })

  it('accepts a recovery code once after an OAuth callback, then rejects it on password sign-in', async () => {
    const address = email('hold-recovery')
    const { recoveryCodes } = await enableMfa(address)
    const callback = await responseWithSession(address, 302, { location: `${APP_URL}/inbox` })
    const held = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/callback/google`, { method: 'GET' }),
      callback,
      routeMocks(),
    )
    const code = recoveryCodes[0]!
    const first = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challengeCookieOf(held), { code }), routeMocks())
    assert.equal(first.status, 200)
    assert.equal(forwardsSessionCookie(first), true)
    const user = await userByEmail(address)
    assert.ok(user)
    const events = await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))
    assert.ok(events.some((event) => event.type === ACCOUNT_SECURITY_EVENT.recoveryCodeUsed))

    const signIn = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    const gated = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signIn,
      routeMocks(),
    )
    const second = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challengeCookieOf(gated), { code }), routeMocks())
    assert.equal(second.status, 400)
  })

  it('shares the verify lockout between an OAuth callback and password sign-in', async () => {
    const address = email('hold-lockout')
    const { secret } = await enableMfa(address)
    const callback = await responseWithSession(address, 302, { location: `${APP_URL}/inbox` })
    const held = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/callback/google`, { method: 'GET' }),
      callback,
      routeMocks(),
    )
    const challenge = challengeCookieOf(held)
    for (let i = 0; i < MFA_VERIFY_FAILURE_LIMIT; i += 1) {
      const failed = await handleMfaVerify(post(MFA_VERIFY_ENDPOINT, challenge, { code: '000000' }), routeMocks())
      assert.equal(failed.status, 400)
    }
    const signIn = (await authApi.signInEmail({
      body: { email: address, password: PASSWORD },
      asResponse: true,
    })) as unknown as Response
    const gated = await holdPasswordSignInIfMfa(
      new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' }),
      signIn,
      routeMocks(),
    )
    const locked = await handleMfaVerify(
      post(MFA_VERIFY_ENDPOINT, challengeCookieOf(gated), { code: totpAt(secret, 1) }),
      mocksAt(1),
    )
    assert.equal(locked.status, 429)
    const user = await userByEmail(address)
    assert.ok(user)
    const events = await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))
    assert.ok(events.some((event) => event.type === ACCOUNT_SECURITY_EVENT.verificationLockout))
  })
})
