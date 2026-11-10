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
import { holdPasswordSignInIfMfa } from './mfa-sign-in'
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
