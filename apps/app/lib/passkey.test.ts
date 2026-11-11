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
import { auth } from './auth'
import { db, pool } from './db'
import { CURRENT_PASSWORD_INCORRECT_MESSAGE } from './password-change'
import { newId } from './ids'
import {
  PASSKEY_PLUGIN_MANAGEMENT_PATHS,
  PASSKEY_REGISTER_ENDPOINT,
  PASSKEY_REGISTER_OPTIONS_ENDPOINT,
  PASSKEY_CHALLENGE_COOKIE,
  buildPasskeyAddedEmail,
  isPasskeyPluginManagementPath,
  passkeyDeleteEndpoint,
  passkeyItemEndpoint,
  submitPasskeyRegisterOptions,
} from './passkey'
import {
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
import { isEmailPasswordSignIn } from './mfa-sign-in'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `passkey-${run}.example.com`
const PASSWORD = 'correct-horse-battery'
const NOW = 1_700_000_040_000
const PUBLIC_KEY = new Uint8Array([1, 2, 3, 4, 5])

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

function post(endpoint: string, cookie: string | undefined, body: unknown) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: APP_URL,
  }
  if (cookie) headers.cookie = cookie
  return new Request(`${APP_URL}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function get(endpoint: string, cookie: string | undefined) {
  const headers: Record<string, string> = { origin: APP_URL }
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
    generateRegistrationOptions: async () =>
      ({
        challenge: 'test-challenge',
        rp: { name: 'HITLy', id: 'localhost' },
        user: { id: 'dGVzdA', name: 'alex@example.com', displayName: 'Alex' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      }) as Awaited<ReturnType<NonNullable<PasskeyRouteDeps['generateRegistrationOptions']>>>,
    verifyRegistrationResponse: async (opts) => {
      assert.equal(opts.expectedChallenge, 'test-challenge')
      assert.equal(opts.expectedRPID, webAuthnRelyingParty().rpID)
      assert.equal(opts.expectedOrigin, webAuthnRelyingParty().origin)
      assert.equal(opts.requireUserVerification, false)
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
    assert.equal(payload.rp.id, 'localhost')
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

  it('plugin management paths 404; authenticate paths stay open; MFA hold is email-only', () => {
    for (const pathName of PASSKEY_PLUGIN_MANAGEMENT_PATHS) {
      assert.equal(isPasskeyPluginManagementPath(`http://localhost:3001/api/auth${pathName}`), true)
    }
    assert.equal(
      isPasskeyPluginManagementPath('http://localhost:3001/api/auth/passkey/generate-authenticate-options'),
      false,
    )
    assert.equal(isPasskeyPluginManagementPath('http://localhost:3001/api/auth/passkey/verify-authentication'), false)
    const route = fs.readFileSync(path.join(__dirname, '../app/api/auth/[...all]/route.ts'), 'utf-8')
    assert.ok(route.includes('isPasskeyPluginManagementPath'))
    const authSource = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8')
    assert.ok(authSource.includes('passkey('))
    assert.ok(authSource.includes('webAuthnRelyingParty'))
    assert.ok(authSource.includes('passkey: schema.passkeys'))
    const page = fs.readFileSync(path.join(__dirname, '../app/settings/security/page.tsx'), 'utf-8')
    assert.ok(page.includes('<PasskeySetup'))
    assert.ok(page.includes('listPasskeysForUser'))
    const login = fs.readFileSync(path.join(__dirname, '../app/login/page.tsx'), 'utf-8')
    assert.ok(login.includes('<PasskeySignIn'))
    const form = fs.readFileSync(path.join(__dirname, '../components/auth-form.tsx'), 'utf-8')
    assert.ok(form.includes('username webauthn'))
    assert.equal(isEmailPasswordSignIn(new Request(`${APP_URL}/api/auth/sign-in/email`, { method: 'POST' })), true)
    assert.equal(
      isEmailPasswordSignIn(new Request(`${APP_URL}/api/auth/passkey/verify-authentication`, { method: 'POST' })),
      false,
    )
    for (const name of ['register/options', 'register', '[id]/delete'] as const) {
      const file = fs.readFileSync(path.join(__dirname, `../app/api/session/passkey/${name}/route.ts`), 'utf-8')
      assert.ok(file.includes('isSameOrigin'))
    }
  })
})
