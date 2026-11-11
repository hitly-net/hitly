/**
 * LIVE passkey tests against real Postgres and the app's real Better Auth
 * instance (same harness as lib/password-change.live.test.ts): plugin
 * authenticate (deleted credential cannot sign in, challenge replay), and
 * passkey sign-in skipping the MFA hold that wraps email/password.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'
process.env.HITLY_SIGNUP_ENABLED = '1'
process.env.HITLY_MFA_ENCRYPTION_KEY ??= 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray, like } from 'drizzle-orm'
import { base64 } from '@better-auth/utils/base64'
import { accounts, memberships, passkeys, sessions, userMfa, users, workspaces } from '@hitly/db/schema'
import { auth } from './auth'
import { db, pool } from './db'
import { handleAuthRequest } from '../app/api/auth/[...all]/route'
import { newId } from './ids'
import { holdPasswordSignInIfMfa } from './mfa-sign-in'
import {
  PASSKEY_PLUGIN_AUTHENTICATE_PATHS,
  PASSKEY_PLUGIN_MANAGEMENT_PATHS,
  PASSKEY_USER_VERIFICATION,
  assertionHasUserVerification,
} from './passkey'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authInstance = auth
const authApi = authInstance.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `passkey-live-${run}.example.com`
const PASSWORD = 'correct-horse-battery'

function email(local: string) {
  return `${local}@${emailDomain}`
}

async function createUser(address: string) {
  await authApi.signUpEmail({ body: { email: address, name: 'Alex', password: PASSWORD } })
}

async function userByEmail(address: string) {
  const rows = await database.select().from(users).where(eq(users.email, address.toLowerCase())).limit(1)
  return rows[0] ?? null
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

async function insertPasskey(userId: string, credentialID: string) {
  const id = newId('pk').slice(0, 36)
  await database.insert(passkeys).values({
    id,
    name: 'Test key',
    publicKey: base64.encode(new Uint8Array([1, 2, 3, 4])),
    userId,
    credentialID,
    counter: 1,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: 'internal',
    aaguid: '00000000-0000-0000-0000-000000000000',
  })
  return id
}

function authenticatorData(userVerified: boolean): string {
  const bytes = new Uint8Array(37)
  bytes[32] = 0b0000_0001 | (userVerified ? 0b0000_0100 : 0)
  return Buffer.from(bytes).toString('base64url')
}

function fakeAssertion(credentialID: string, userVerified = true) {
  return {
    id: credentialID,
    rawId: credentialID,
    type: 'public-key',
    response: {
      clientDataJSON: 'e30',
      authenticatorData: authenticatorData(userVerified),
      signature: 'AA',
      userHandle: '',
    },
  }
}

before(() => {})

after(async () => {
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

describe('passkey plugin sign-in', () => {
  it('a deleted passkey cannot sign in', async () => {
    const address = email('deleted')
    await createUser(address)
    const user = await userByEmail(address)
    assert.ok(user)
    const credentialID = `live-del-${run}`
    const passkeyId = await insertPasskey(user.id, credentialID)

    const options = await authInstance.handler(
      new Request(`${APP_URL}/api/auth/passkey/generate-authenticate-options`, {
        method: 'GET',
        headers: { origin: APP_URL },
      }),
    )
    assert.equal(options.status, 200)
    await database.delete(passkeys).where(eq(passkeys.id, passkeyId))

    const verify = await authInstance.handler(
      new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, {
        method: 'POST',
        headers: {
          origin: APP_URL,
          'content-type': 'application/json',
          cookie: cookieHeader(options),
        },
        body: JSON.stringify({ response: fakeAssertion(credentialID) }),
      }),
    )
    assert.equal(verify.status, 401)
    const body = (await verify.json().catch(() => ({}))) as { code?: string }
    assert.equal(body.code, 'PASSKEY_NOT_FOUND')
  })

  it('rejects a replayed authentication challenge', async () => {
    const address = email('replay')
    await createUser(address)
    const user = await userByEmail(address)
    assert.ok(user)
    const credentialID = `live-replay-${run}`
    await insertPasskey(user.id, credentialID)

    const options = await authInstance.handler(
      new Request(`${APP_URL}/api/auth/passkey/generate-authenticate-options`, {
        method: 'GET',
        headers: { origin: APP_URL },
      }),
    )
    assert.equal(options.status, 200)
    const cookie = cookieHeader(options)
    const first = await authInstance.handler(
      new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'application/json', cookie },
        body: JSON.stringify({ response: fakeAssertion(credentialID) }),
      }),
    )
    assert.ok(first.status >= 400)
    const replay = await authInstance.handler(
      new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'application/json', cookie },
        body: JSON.stringify({ response: fakeAssertion(credentialID) }),
      }),
    )
    assert.equal(replay.status, 400)
    const body = (await replay.json().catch(() => ({}))) as { code?: string }
    assert.equal(body.code, 'CHALLENGE_NOT_FOUND')
  })

  it('does not hold a passkey sign-in for TOTP MFA', async () => {
    const passkeySignIn = new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, { method: 'POST' })
    const fakeSession = new Response(JSON.stringify({ user: { id: 'usr_x' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'better-auth.session_token=abc; Path=/' },
    })
    const held = await holdPasswordSignInIfMfa(passkeySignIn, fakeSession)
    assert.equal(held, fakeSession)
  })

  it('a TOTP-enrolled user presenting a passkey assertion without UV gets no session', async () => {
    const address = email('uv-totp')
    await createUser(address)
    const user = await userByEmail(address)
    assert.ok(user)
    await database.insert(userMfa).values({
      id: newId('mfa').slice(0, 36),
      userId: user.id,
      totpCiphertext: 'placeholder-ciphertext',
      enabled: true,
    })
    const credentialID = `live-uv-${run}`
    await insertPasskey(user.id, credentialID)
    const sessionsBefore = await database.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id))

    const uvLess = { response: fakeAssertion(credentialID, false) }
    assert.equal(assertionHasUserVerification(uvLess), false)

    const verify = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, {
        method: 'POST',
        headers: {
          origin: APP_URL,
          host: 'spoof.example.net:8443',
          'content-type': 'application/json',
        },
        body: JSON.stringify(uvLess),
      }),
      async () => {
        throw new Error('plugin must not run for a UV-less assertion')
      },
    )
    assert.equal(verify.status, 400)
    const body = (await verify.json().catch(() => ({}))) as { code?: string }
    assert.equal(body.code, 'USER_VERIFICATION_REQUIRED')
    const setCookies = verify.headers.getSetCookie().join(';')
    assert.ok(!/session_token/i.test(setCookies))
    const sessionsAfter = await database.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id))
    assert.equal(sessionsAfter.length, sessionsBefore.length)
  })

  it('a passkey assertion with UV is admitted to the stock handler', async () => {
    // Positive counterpart of the UV-less pre-check: flags bit 0x04 at
    // offset 32 must pass the catch-all and reach the plugin. A mutant
    // that makes assertionHasUserVerification always return false would
    // 400 here and never call the handler (silently breaking every sign-in).
    const uvSet = { response: fakeAssertion(`live-uv-ok-${run}`, true) }
    assert.equal(assertionHasUserVerification(uvSet), true)
    let ran = false
    const verify = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, {
        method: 'POST',
        headers: {
          origin: APP_URL,
          'content-type': 'application/json',
        },
        body: JSON.stringify(uvSet),
      }),
      async () => {
        ran = true
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    )
    assert.equal(ran, true, 'UV assertion must reach the stock handler')
    assert.equal(verify.status, 200)
    const body = (await verify.json().catch(() => ({}))) as { code?: string }
    assert.notEqual(body.code, 'USER_VERIFICATION_REQUIRED')
  })

  it('authenticate options require user verification even when Host disagrees with BETTER_AUTH_URL', async () => {
    const options = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/passkey/generate-authenticate-options`, {
        method: 'GET',
        headers: { origin: APP_URL, host: 'spoof.example.net:8443' },
      }),
      (request) => authInstance.handler(request),
    )
    assert.equal(options.status, 200)
    const body = (await options.json()) as { userVerification?: string; rpId?: string }
    assert.equal(body.userVerification, PASSKEY_USER_VERIFICATION)
    const rpHost = new URL(APP_URL).hostname
    assert.equal(body.rpId, rpHost)
    assert.ok(!body.rpId?.includes(':'))
    assert.notEqual(body.rpId, 'spoof.example.net')
  })

  it('404s plugin management paths so register/delete cannot skip the password check', async () => {
    const runHandler = async () => new Response('should-not-run', { status: 200 })
    for (const pathName of PASSKEY_PLUGIN_MANAGEMENT_PATHS) {
      const method = pathName.includes('generate') || pathName.includes('list') ? 'GET' : 'POST'
      for (const suffix of ['', '/']) {
        const response = await handleAuthRequest(
          new Request(`${APP_URL}/api/auth${pathName}${suffix}`, { method }),
          runHandler,
        )
        assert.equal(response.status, 404, `${pathName}${suffix}`)
        assert.deepEqual(await response.json(), { error: 'Not found' })
      }
    }
    let ran = false
    const allowed = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/passkey/generate-authenticate-options`, { method: 'GET' }),
      async () => {
        ran = true
        return new Response(JSON.stringify({ challenge: 'x', userVerification: 'preferred' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    )
    assert.equal(ran, true)
    assert.equal(allowed.status, 200)
    assert.equal(((await allowed.json()) as { userVerification?: string }).userVerification, PASSKEY_USER_VERIFICATION)
    for (const pathName of PASSKEY_PLUGIN_AUTHENTICATE_PATHS) {
      const slashed = await handleAuthRequest(
        new Request(`${APP_URL}/api/auth${pathName}/`, { method: 'GET' }),
        async () => new Response('ok', { status: 200 }),
      )
      assert.notEqual(slashed.status, 404, pathName)
    }
  })
})
