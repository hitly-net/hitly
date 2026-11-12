/**
 * Account passkeys against real Postgres and the app's real Better Auth
 * instance: register (password + WebAuthn verify), own-only access, re-auth,
 * challenge replay, delete, notice email, and no secrets in logs.
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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { passkey as passkeyPlugin } from '@better-auth/passkey'
import { and, eq, inArray, like } from 'drizzle-orm'
import {
  accountSecurityEvents,
  accounts,
  memberships,
  passkeys,
  sessions,
  users,
  workspaces,
} from '@hitly/db/schema'
import { handleAuthRequest } from '../app/api/auth/[...all]/route'
import { auth } from './auth'
import { db, pool } from './db'
import { CURRENT_PASSWORD_INCORRECT_MESSAGE } from './password-change'
import { newId } from './ids'
import { PasskeySetup } from '../components/passkey-setup'
import {
  PASSKEY_PLUGIN_AUTHENTICATE_PATHS,
  PASSKEY_PLUGIN_MANAGEMENT_PATHS,
  PASSKEY_REGISTER_ENDPOINT,
  PASSKEY_REGISTER_OPTIONS_ENDPOINT,
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_USER_VERIFICATION,
  assertionHasUserVerification,
  buildPasskeyAddedEmail,
  isPasskeyPluginManagementPath,
  passkeyDeleteEndpoint,
  passkeyItemEndpoint,
  submitPasskeyRegisterOptions,
} from './passkey'
import {
  consumePasskeyRegisterChallenge,
  handlePasskeyDelete,
  handlePasskeyGet,
  handlePasskeyRegister,
  handlePasskeyRegisterOptions,
  handlePasskeyRename,
  listPasskeysForUser,
  PASSKEY_ADDED_LOG,
  PASSKEY_REMOVED_LOG,
  PASSKEY_SECURITY_EVENT,
  type PasskeyRouteDeps,
} from './passkey-route'
import { webAuthnRelyingParty } from './webauthn-rp'
import { isEmailPasswordSignIn, isSignInHeld, sessionRoutePolicyFor } from './mfa-sign-in'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `passkey-${run}.example.com`
const PASSWORD = 'correct-horse-battery'
const NOW = 1_700_000_040_000
const PUBLIC_KEY = new Uint8Array([1, 2, 3, 4, 5])
/** Host that disagrees with BETTER_AUTH_URL; RP ID/origin must ignore it. */
const SPOOF_HOST = 'spoof.example.net:8443'

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

function post(endpoint: string, cookie: string | undefined, body: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_URL,
    host: SPOOF_HOST,
    ...extraHeaders,
  }
  if (cookie) headers.cookie = cookie
  return new Request(`${APP_URL}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function get(endpoint: string, cookie: string | undefined) {
  const headers: Record<string, string> = { origin: APP_URL, host: SPOOF_HOST }
  if (cookie) headers.cookie = cookie
  return new Request(`${APP_URL}${endpoint}`, { method: 'GET', headers })
}

function challengeCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${PASSKEY_CHALLENGE_COOKIE}=`))
  return header ? header.split(';')[0]! : ''
}

function mergeCookie(session: string, extra: string) {
  return [session, extra].filter(Boolean).join('; ')
}

function attestation(id: string) {
  return {
    id,
    rawId: id,
    type: 'public-key' as const,
    response: { clientDataJSON: 'e30', attestationObject: 'AA', transports: ['internal'] },
  }
}

function verifiedRegistration(credentialID: string, counter = 0) {
  return {
    verified: true as const,
    registrationInfo: {
      fmt: 'none' as const,
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: { id: credentialID, publicKey: PUBLIC_KEY, counter },
      credentialType: 'public-key' as const,
      attestationObject: new Uint8Array([0]),
      userVerified: true,
      credentialDeviceType: 'singleDevice' as const,
      credentialBackedUp: false,
      origin: APP_URL,
    },
  }
}

function routeMocks(overrides: Partial<PasskeyRouteDeps> = {}, credentialID = `cred-${run}`): PasskeyRouteDeps {
  return {
    log: () => {},
    now: () => NOW,
    allowReauth: () => true,
    generateRegistrationOptions: async (opts) => {
      const rp = webAuthnRelyingParty()
      assert.equal(opts.rpID, rp.rpID)
      assert.ok(!opts.rpID.includes(':'), 'rpID must strip the port')
      assert.notEqual(opts.rpID, 'spoof.example.net')
      assert.equal(opts.authenticatorSelection?.userVerification, PASSKEY_USER_VERIFICATION)
      return {
        challenge: 'test-challenge',
        rp: { name: 'HITLy', id: rp.rpID },
        user: { id: 'dGVzdA', name: 'alex@example.com', displayName: 'Alex' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      } as Awaited<ReturnType<NonNullable<PasskeyRouteDeps['generateRegistrationOptions']>>>
    },
    verifyRegistrationResponse: async (opts) => {
      const rp = webAuthnRelyingParty()
      assert.equal(opts.expectedChallenge, 'test-challenge')
      assert.equal(opts.expectedRPID, rp.rpID)
      assert.equal(opts.expectedOrigin, rp.origin)
      assert.equal(opts.requireUserVerification, true)
      return verifiedRegistration(credentialID, 0)
    },
    notifyAdded: async () => {},
    ...overrides,
  }
}

async function registerPasskey(address: string, credentialID: string, deps: PasskeyRouteDeps = routeMocks({}, credentialID)) {
  await createUser(address)
  const cookie = await signInCookie(address)
  const options = await handlePasskeyRegisterOptions(
    post(PASSKEY_REGISTER_OPTIONS_ENDPOINT, cookie, { currentPassword: PASSWORD, name: 'Laptop' }),
    deps,
  )
  assert.equal(options.status, 200)
  const challenge = challengeCookie(options)
  const registered = await handlePasskeyRegister(
    post(PASSKEY_REGISTER_ENDPOINT, mergeCookie(cookie, challenge), { response: attestation(credentialID), name: 'Laptop' }),
    deps,
  )
  assert.equal(registered.status, 200)
  const user = await userByEmail(address)
  assert.ok(user)
  const rows = await database.select().from(passkeys).where(eq(passkeys.userId, user.id))
  return { cookie, user, passkey: rows[0]!, challenge, options }
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

describe('passkey RP config', () => {
  it('takes rpID and origin from BETTER_AUTH_URL, never a hardcoded host', () => {
    const rp = webAuthnRelyingParty({ BETTER_AUTH_URL: 'https://app.example.com' })
    assert.equal(rp.rpID, 'app.example.com')
    assert.equal(rp.origin, 'https://app.example.com')
    assert.equal(rp.rpName, 'HITLy')
    const named = webAuthnRelyingParty({
      BETTER_AUTH_URL: 'https://app.example.com:8443',
      HITLY_WEBAUTHN_RP_NAME: 'Example Inbox',
    })
    assert.equal(named.rpID, 'app.example.com')
    assert.equal(named.origin, 'https://app.example.com:8443')
    assert.equal(named.rpName, 'Example Inbox')
    const source = fs.readFileSync(path.join(__dirname, 'webauthn-rp.ts'), 'utf-8')
    assert.ok(!/1(?:0|27|69|72|92)\.\d+/.test(source), 'RP helper must not hardcode private IPs')
    assert.ok(!/headers\.get\(\s*['"]host['"]\s*\)/i.test(source), 'RP helper must not read Host')
  })

  it('a Host header that disagrees with BETTER_AUTH_URL does not change rpID or expected origin', async () => {
    const address = email('rp-host')
    await createUser(address)
    const cookie = await signInCookie(address)
    const cred = `cred-host-${run}`
    const captured: {
      rpID?: string
      expectedRPID?: string
      expectedOrigin?: string
    } = {}
    const deps = routeMocks(
      {
        generateRegistrationOptions: async (opts) => {
          captured.rpID = opts.rpID
          assert.equal(opts.authenticatorSelection?.userVerification, PASSKEY_USER_VERIFICATION)
          return {
            challenge: 'test-challenge',
            rp: { name: 'HITLy', id: captured.rpID },
            user: { id: 'dGVzdA', name: 'alex@example.com', displayName: 'Alex' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          } as Awaited<ReturnType<NonNullable<PasskeyRouteDeps['generateRegistrationOptions']>>>
        },
        verifyRegistrationResponse: async (opts) => {
          captured.expectedRPID = Array.isArray(opts.expectedRPID) ? opts.expectedRPID[0] : opts.expectedRPID
          captured.expectedOrigin = Array.isArray(opts.expectedOrigin) ? opts.expectedOrigin[0] : opts.expectedOrigin
          assert.equal(opts.requireUserVerification, true)
          return verifiedRegistration(cred, 0)
        },
      },
      cred,
    )
    const options = await handlePasskeyRegisterOptions(
      post(PASSKEY_REGISTER_OPTIONS_ENDPOINT, cookie, { currentPassword: PASSWORD, name: 'Laptop' }, { host: SPOOF_HOST }),
      deps,
    )
    assert.equal(options.status, 200)
    const rp = webAuthnRelyingParty()
    assert.equal(captured.rpID, rp.rpID)
    assert.ok(!captured.rpID!.includes(':'), 'rpID must strip the port from BETTER_AUTH_URL')
    assert.notEqual(captured.rpID, 'spoof.example.net')
    const challenge = challengeCookie(options)
    const registered = await handlePasskeyRegister(
      post(
        PASSKEY_REGISTER_ENDPOINT,
        mergeCookie(cookie, challenge),
        { response: attestation(cred), name: 'Laptop' },
        { host: SPOOF_HOST },
      ),
      deps,
    )
    assert.equal(registered.status, 200)
    assert.equal(captured.expectedRPID, rp.rpID)
    assert.equal(captured.expectedOrigin, rp.origin)
    const routeSrc = fs.readFileSync(path.join(__dirname, 'passkey-route.ts'), 'utf-8')
    assert.ok(!/headers\.get\(\s*['"]host['"]\s*\)/i.test(routeSrc), 'register routes must not take RP ID from Host')
  })
})

describe('passkey registration', () => {
  it('requires the current password and stores the credential after verify', async () => {
    const address = email('register-ok')
    await createUser(address)
    const cookie = await signInCookie(address)
    const user = await userByEmail(address)
    assert.ok(user)
    const cred = `cred-ok-${run}`
    const deps = routeMocks({}, cred)
    const notices: string[] = []
    deps.notifyAdded = async ({ email: to }) => {
      notices.push(to)
    }
    const lines: string[] = []
    deps.log = (line) => lines.push(line)

    const missing = await handlePasskeyRegisterOptions(
      post(PASSKEY_REGISTER_OPTIONS_ENDPOINT, cookie, { currentPassword: '', name: 'Laptop' }),
      deps,
    )
    assert.equal(missing.status, 400)

    const wrong = await handlePasskeyRegisterOptions(
      post(PASSKEY_REGISTER_OPTIONS_ENDPOINT, cookie, { currentPassword: 'not-the-password', name: 'Laptop' }),
      deps,
    )
    assert.equal(wrong.status, 400)
    assert.deepEqual(await wrong.json(), { code: 'INVALID_PASSWORD' })
    assert.equal((await database.select().from(passkeys).where(eq(passkeys.userId, user.id))).length, 0)

    const options = await handlePasskeyRegisterOptions(
      post(PASSKEY_REGISTER_OPTIONS_ENDPOINT, cookie, { currentPassword: PASSWORD, name: 'Laptop' }),
      deps,
    )
    assert.equal(options.status, 200)
    const payload = (await options.json()) as { challenge: string; rp: { id: string } }
    assert.equal(payload.challenge, 'test-challenge')
    assert.equal(payload.rp.id, webAuthnRelyingParty().rpID)
    const challenge = challengeCookie(options)
    assert.ok(challenge.startsWith(`${PASSKEY_CHALLENGE_COOKIE}=`))

    const registered = await handlePasskeyRegister(
      post(PASSKEY_REGISTER_ENDPOINT, mergeCookie(cookie, challenge), { response: attestation(cred), name: 'Laptop' }),
      deps,
    )
    assert.equal(registered.status, 200)
    const body = (await registered.json()) as { ok: true; passkey: { id: string; name: string } }
    assert.equal(body.ok, true)
    assert.equal(body.passkey.name, 'Laptop')
    const stored = await database.select().from(passkeys).where(eq(passkeys.userId, user.id))
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.credentialID, cred)
    assert.equal(stored[0]?.counter, 0)
    const listed = await listPasskeysForUser(user.id)
    assert.equal(listed[0]?.name, 'Laptop')
    assert.equal(listed[0]?.lastUsedAt, null)
    assert.ok(!JSON.stringify(listed).includes(stored[0]!.publicKey), 'list omits the public key')
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(types.includes(PASSKEY_SECURITY_EVENT.added))
    assert.deepEqual(notices, [address])
    assert.ok(lines.some((line) => line === `${PASSKEY_ADDED_LOG} user=${user.id}`))
  })

  it('rejects a replayed registration challenge', async () => {
    const address = email('register-replay')
    const cred = `cred-replay-${run}`
    const { cookie, challenge } = await registerPasskey(address, cred)
    const replay = await handlePasskeyRegister(
      post(PASSKEY_REGISTER_ENDPOINT, mergeCookie(cookie, challenge), { response: attestation(`${cred}-2`), name: 'Laptop' }),
      routeMocks({}, `${cred}-2`),
    )
    assert.equal(replay.status, 400)
    assert.deepEqual(await replay.json(), { error: 'challenge_not_found' })
  })

  it('consumes a registration challenge atomically so a concurrent replay cannot succeed', async () => {
    const address = email('register-race')
    const cred = `cred-race-${run}`
    await createUser(address)
    const cookie = await signInCookie(address)
    const options = await handlePasskeyRegisterOptions(
      post(PASSKEY_REGISTER_OPTIONS_ENDPOINT, cookie, { currentPassword: PASSWORD, name: 'Laptop' }),
      routeMocks({}, cred),
    )
    assert.equal(options.status, 200)
    const challenge = challengeCookie(options)
    const [first, second] = await Promise.all([
      handlePasskeyRegister(
        post(PASSKEY_REGISTER_ENDPOINT, mergeCookie(cookie, challenge), { response: attestation(`${cred}-a`), name: 'Laptop' }),
        routeMocks({}, `${cred}-a`),
      ),
      handlePasskeyRegister(
        post(PASSKEY_REGISTER_ENDPOINT, mergeCookie(cookie, challenge), { response: attestation(`${cred}-b`), name: 'Laptop' }),
        routeMocks({}, `${cred}-b`),
      ),
    ])
    const statuses = [first.status, second.status].sort()
    assert.deepEqual(statuses, [200, 400])
    const loser = first.status === 400 ? first : second
    assert.deepEqual(await loser.json(), { error: 'challenge_not_found' })
    const user = await userByEmail(address)
    assert.ok(user)
    assert.equal((await database.select().from(passkeys).where(eq(passkeys.userId, user.id))).length, 1)
    const routeSrc = fs.readFileSync(path.join(__dirname, 'passkey-route.ts'), 'utf-8')
    assert.match(routeSrc, /delete\(verifications\)[\s\S]*?\.returning\(/)
    assert.equal(typeof consumePasskeyRegisterChallenge, 'function')
  })
})

describe('passkey own-only access', () => {
  it('GET, rename and delete of another user passkey are 404 and change nothing', async () => {
    const owner = email('own-owner')
    const other = email('own-other')
    const cred = `cred-own-${run}`
    const { cookie: ownerCookie, user, passkey } = await registerPasskey(owner, cred)
    await createUser(other)
    const otherCookie = await signInCookie(other)

    const got = await handlePasskeyGet(get(passkeyItemEndpoint(passkey.id), otherCookie), passkey.id, routeMocks())
    assert.equal(got.status, 404)
    assert.deepEqual(await got.json(), { error: 'not_found' })

    const renamed = await handlePasskeyRename(
      post(passkeyItemEndpoint(passkey.id), otherCookie, { name: 'Stolen' }),
      passkey.id,
      routeMocks(),
    )
    assert.equal(renamed.status, 404)
    const afterRename = await handlePasskeyGet(get(passkeyItemEndpoint(passkey.id), ownerCookie), passkey.id, routeMocks())
    assert.equal(afterRename.status, 200)
    assert.equal(((await afterRename.json()) as { name: string }).name, 'Laptop')

    const deleted = await handlePasskeyDelete(
      post(passkeyDeleteEndpoint(passkey.id), otherCookie, { currentPassword: PASSWORD }),
      passkey.id,
      routeMocks(),
    )
    assert.equal(deleted.status, 404)
    assert.equal((await database.select().from(passkeys).where(eq(passkeys.id, passkey.id))).length, 1)
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(!types.includes(PASSKEY_SECURITY_EVENT.removed))
  })
})

describe('passkey delete re-auth', () => {
  it('refuses a wrong password and deletes after the current password', async () => {
    const address = email('delete-ok')
    const cred = `cred-del-${run}`
    const lines: string[] = []
    const { cookie, user, passkey } = await registerPasskey(address, cred)
    const wrong = await handlePasskeyDelete(
      post(passkeyDeleteEndpoint(passkey.id), cookie, { currentPassword: 'not-the-password' }),
      passkey.id,
      routeMocks(),
    )
    assert.equal(wrong.status, 400)
    assert.deepEqual(await wrong.json(), { code: 'INVALID_PASSWORD' })
    assert.equal((await database.select().from(passkeys).where(eq(passkeys.id, passkey.id))).length, 1)

    const ok = await handlePasskeyDelete(
      post(passkeyDeleteEndpoint(passkey.id), cookie, { currentPassword: PASSWORD }),
      passkey.id,
      routeMocks({ log: (line) => lines.push(line) }),
    )
    assert.equal(ok.status, 200)
    assert.equal((await database.select().from(passkeys).where(eq(passkeys.id, passkey.id))).length, 0)
    const types = (await database.select().from(accountSecurityEvents).where(eq(accountSecurityEvents.userId, user.id))).map(
      (event) => event.type,
    )
    assert.ok(types.includes(PASSKEY_SECURITY_EVENT.removed))
    assert.ok(lines.some((line) => line === `${PASSKEY_REMOVED_LOG} user=${user.id}`))
  })
})

describe('passkey settings list rendering', () => {
  it('server-rendered settings list omits publicKey and credential bytes', async () => {
    const address = email('list-ssr')
    const cred = `cred-ssr-${run}-CANARYCRED`
    const { user, passkey } = await registerPasskey(address, cred)
    assert.ok(passkey.publicKey)
    assert.ok(passkey.credentialID)
    const listed = await listPasskeysForUser(user.id)
    const html = renderToStaticMarkup(createElement(PasskeySetup, { passkeys: listed }))
    const output = `${JSON.stringify(listed)}\n${html}`
    assert.match(html, /Laptop/)
    assert.ok(!output.includes(passkey.publicKey), 'rendered list must not include the public key')
    assert.ok(!output.includes(passkey.credentialID), 'rendered list must not include the credential id')
    const page = fs.readFileSync(path.join(__dirname, '../app/settings/security/page.tsx'), 'utf-8')
    assert.ok(page.includes('listPasskeysForUser'))
    assert.ok(!page.includes('publicKey'))
  })
})

describe('passkey user-verification helper and auth catch-all pre-check', () => {
  const USER_VERIFIED_FLAG = 0x04

  function authenticatorData(userVerified: boolean): string {
    const bytes = new Uint8Array(37)
    bytes[32] = 0x01 | (userVerified ? USER_VERIFIED_FLAG : 0)
    return Buffer.from(bytes).toString('base64url')
  }

  function assertionBody(userVerified: boolean) {
    return {
      response: {
        response: {
          authenticatorData: authenticatorData(userVerified),
        },
      },
    }
  }

  it('assertionHasUserVerification is true when UV flag 0x04 is set at offset 32', () => {
    assert.equal(assertionHasUserVerification(assertionBody(true)), true)
  })

  it('assertionHasUserVerification is false when UV flag is unset', () => {
    assert.equal(assertionHasUserVerification(assertionBody(false)), false)
  })

  it('auth catch-all admits a UV assertion to the stock handler', async () => {
    // Kills assertionHasUserVerification always returning false: that mutant
    // would 400 USER_VERIFICATION_REQUIRED here and never call the handler.
    const body = assertionBody(true)
    assert.equal(assertionHasUserVerification(body), true)
    let ran = false
    const response = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
    assert.equal(response.status, 200)
    const payload = (await response.json()) as { code?: string }
    assert.notEqual(payload.code, 'USER_VERIFICATION_REQUIRED')
  })
})

describe('passkey client helpers and static wiring', () => {
  it('maps INVALID_PASSWORD through the shared current-password message', async () => {
    const fake: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 'INVALID_PASSWORD' }), { status: 400, headers: { 'content-type': 'application/json' } })
    const outcome = await submitPasskeyRegisterOptions('x', 'Laptop', fake)
    assert.deepEqual(outcome, { ok: false, message: CURRENT_PASSWORD_INCORRECT_MESSAGE })
  })

  it('the notice email carries no secret', () => {
    const mail = buildPasskeyAddedEmail({ to: email('notice') })
    assert.match(mail.subject, /passkey/i)
    assert.ok(!mail.text.includes(PASSWORD))
    assert.ok(!mail.text.includes('http://'))
  })

  it('plugin management paths 404; authenticate paths stay open; UV passkey sign-in is not held', () => {
    const stock = Object.values(passkeyPlugin().endpoints)
      .map((endpoint) => endpoint.path as string)
      .sort()
    const authenticate = new Set<string>(PASSKEY_PLUGIN_AUTHENTICATE_PATHS)
    const expectedBlocklist = stock.filter((pathName) => !authenticate.has(pathName)).sort()
    assert.deepEqual([...PASSKEY_PLUGIN_MANAGEMENT_PATHS].slice().sort(), expectedBlocklist)
    assert.ok(PASSKEY_PLUGIN_AUTHENTICATE_PATHS.every((pathName) => stock.includes(pathName)))
    for (const pathName of PASSKEY_PLUGIN_MANAGEMENT_PATHS) {
      assert.equal(isPasskeyPluginManagementPath(`http://localhost:3001/api/auth${pathName}`), true)
      assert.equal(isPasskeyPluginManagementPath(`http://localhost:3001/api/auth${pathName}/`), true)
      assert.equal(isPasskeyPluginManagementPath(`http://localhost:3001/API/AUTH${pathName.toUpperCase()}`), true)
    }
    assert.equal(
      isPasskeyPluginManagementPath('http://localhost:3001/api/auth/passkey/generate-authenticate-options'),
      false,
    )
    assert.equal(isPasskeyPluginManagementPath('http://localhost:3001/api/auth/passkey/verify-authentication'), false)
    assert.equal(isPasskeyPluginManagementPath('http://localhost:3001/api/auth/passkey/verify-authentication/'), false)
    assert.equal(
      assertionHasUserVerification({
        response: { response: { authenticatorData: Buffer.from([0, 0, 0]).toString('base64url') } },
      }),
      false,
    )
    const route = fs.readFileSync(path.join(__dirname, '../app/api/auth/[...all]/route.ts'), 'utf-8')
    assert.ok(route.includes('isPasskeyPluginManagementPath'))
    const authSource = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8')
    assert.ok(authSource.includes('passkey('))
    assert.ok(authSource.includes('webAuthnRelyingParty'))
    assert.ok(authSource.includes('passkey: schema.passkeys'))
    assert.ok(authSource.includes('PASSKEY_USER_VERIFICATION'))
    assert.ok(authSource.includes('authenticatorSelection'))
    const page = fs.readFileSync(path.join(__dirname, '../app/settings/security/page.tsx'), 'utf-8')
    assert.ok(page.includes('<PasskeySetup'))
    assert.ok(page.includes('listPasskeysForUser'))
    const login = fs.readFileSync(path.join(__dirname, '../app/login/page.tsx'), 'utf-8')
    assert.ok(login.includes('<PasskeySignIn'))
    const form = fs.readFileSync(path.join(__dirname, '../components/auth-form.tsx'), 'utf-8')
    assert.ok(form.includes('username webauthn'))
    const docs = fs.readFileSync(path.join(__dirname, '../../web/content/docs/self-host.mdx'), 'utf-8')
    assert.match(docs, /user verification/i)
    const routeSrc = fs.readFileSync(path.join(__dirname, 'passkey-route.ts'), 'utf-8')
    assert.match(routeSrc, /requireUserVerification:\s*true/)
    assert.match(routeSrc, /userVerification:\s*PASSKEY_USER_VERIFICATION/)
    assert.equal(isEmailPasswordSignIn(new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' })), true)
    const passkeySignIn = new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, { method: 'POST' })
    assert.equal(isEmailPasswordSignIn(passkeySignIn), false)
    assert.equal(isSignInHeld(passkeySignIn), false)
    assert.equal(sessionRoutePolicyFor(passkeySignIn)?.action, 'uv-satisfies-mfa')
    assert.equal(sessionRoutePolicyFor(passkeySignIn)?.mfa.startsWith('MFA satisfied by UV'), true)
    for (const name of ['register/options', 'register', '[id]/delete'] as const) {
      const file = fs.readFileSync(path.join(__dirname, `../app/api/session/passkey/${name}/route.ts`), 'utf-8')
      assert.ok(file.includes('isSameOrigin'))
    }
  })
})
