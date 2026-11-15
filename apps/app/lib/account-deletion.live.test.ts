/**
 * LIVE account-deletion tests against real Postgres and the real Better Auth
 * instance: auth and ownership, the re-auth ticket lifecycle, the blockers,
 * the cascade (what goes), the anonymisation (what stays), idempotency, and
 * the notices.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'
process.env.HITLY_SIGNUP_ENABLED = '1'
process.env.HITLY_MFA_ENCRYPTION_KEY ??= 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
process.env.HITLY_SECURITY_EVENT_HMAC_KEY ??= 'hg5b-test-hmac-key-0123456789abcdef'

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  accountSecurityEvents,
  approvals,
  decisionRecords,
  invites,
  memberships,
  passkeys,
  pendingEmailChanges,
  pendingEmailVerifications,
  projectApiKeys,
  projectEvents,
  projects,
  sessions,
  users,
  verifications,
  workspaces,
} from '@hitly/db/schema'
import { clearSentMail, sentMail } from '@hitly/mail'
import { auth } from './auth'
import { db } from './db'
import { newId } from './ids'
import {
  ACCOUNT_DELETION_SECURITY_EVENT,
  handleAccountDeletion,
  handleAccountExport,
  handleDeletionPreview,
  handleDeletionReauth,
  handleDeletionReauthOptions,
} from './account-deletion-route'
import { DELETION_CHALLENGE_COOKIE } from './account-deletion'
import { resolveSecurityEventHmacKey, securityEventHmac } from './account-deletion-plan'
import { POST as deleteRoutePOST } from '../app/api/session/delete-account/route'
import { POST as reauthRoutePOST } from '../app/api/session/delete-account/reauth/route'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const PASSWORD = 'correct-horse-battery'
const run = newId('t').slice(-10)
const emailDomain = `deletion-${run}.example.com`

type Cookie = string
type Body = Record<string, unknown>

let addressCounter = 0
function freshAddress() {
  addressCounter += 1
  // TEST-NET-3 (RFC 5737) documentation space, unique per request so the
  // per-address limiters cannot bleed across tests.
  return `203.0.113.${(addressCounter % 253) + 1}`
}

function post(path: string, body: Body, cookie: Cookie, extra: Record<string, string> = {}) {
  return {
    headers: new Headers({
      origin: APP_URL,
      'content-type': 'application/json',
      cookie,
      'x-forwarded-for': freshAddress(),
      ...extra,
    }),
    json: async () => body,
  }
}

function get(path: string, cookie: Cookie) {
  return { headers: new Headers({ origin: APP_URL, cookie }), json: async () => ({}) }
}

function stubGenerateOptions(challenge: string, credentialId: string) {
  return (async () => ({
    challenge,
    allowCredentials: [{ id: credentialId }],
    rpID: 'localhost',
    timeout: 60000,
    userVerification: 'required' as const,
  })) as never
}

function stubVerify(credentialId: string, newCounter: number, verified = true) {
  return (async () =>
    verified
      ? {
          verified: true,
          authenticationInfo: {
            credentialID: credentialId,
            newCounter,
            userVerified: true,
            credentialDeviceType: 'singleDevice' as const,
            credentialBackedUp: false,
            origin: APP_URL,
            rpID: 'localhost',
          },
        }
      : { verified: false, authenticationInfo: null }) as never
}

async function signUp(label: string): Promise<{ id: string; email: string; cookie: Cookie }> {
  const email = `${label}-${run}@${emailDomain}`
  await authApi.signUpEmail({ body: { email, password: PASSWORD, name: `User ${label}` } })
  const { headers } = await authApi.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true })
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const rows = await database.select().from(users).where(eq(users.email, email)).limit(1)
  const user = rows[0]
  if (!user) throw new Error(`sign-up did not store ${email}`)
  return { id: user.id, email, cookie }
}

async function userRow(userId: string) {
  const rows = await database.select().from(users).where(eq(users.id, userId)).limit(1)
  return rows[0] ?? null
}

async function makeWorkspace(ownerId: string, name: string) {
  const id = newId('ws').slice(0, 36)
  await database.insert(workspaces).values({ id, name, slug: `${name}-${id.slice(-6)}`.toLowerCase() })
  await database.insert(memberships).values({ id: newId('mem').slice(0, 36), workspaceId: id, userId: ownerId, role: 'owner' })
  return id
}

async function addMember(workspaceId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  await database
    .insert(memberships)
    .values({ id: newId('mem').slice(0, 36), workspaceId, userId, role })
}

async function makeProject(workspaceId: string, name: string) {
  const id = newId('prj').slice(0, 36)
  await database.insert(projects).values({
    id,
    workspaceId,
    name,
    plugin: 'http',
    credentials: { baseUrl: 'https://origin.example.test', token: 'super-secret-token' },
  })
  return id
}

async function makeApiKey(workspaceId: string, projectId: string, name: string) {
  const id = newId('key').slice(0, 36)
  await database.insert(projectApiKeys).values({
    id,
    workspaceId,
    projectId,
    name,
    hashedKey: `hashed-${id}`,
    prefix: 'hitly_ab',
  })
  return id
}

async function makeDecision(args: {
  workspaceId: string
  projectId: string
  actorUserId: string | null
  comment: string
  client?: Record<string, unknown>
}) {
  const approvalId = newId('apv').slice(0, 36)
  await database.insert(approvals).values({
    id: approvalId,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    plugin: 'http',
    status: 'decided',
    actionName: 'send-refund',
    envelope: { action: { name: 'send-refund' } },
    origin: { kind: 'http' },
    assignedUserId: args.actorUserId,
  })
  const id = newId('dec').slice(0, 36)
  await database.insert(decisionRecords).values({
    id,
    workspaceId: args.workspaceId,
    approvalId,
    actorUserId: args.actorUserId,
    decision: 'accept',
    payload: { decision: 'accept', reason: args.comment },
    client: args.client ?? null,
  })
  return { id, approvalId }
}

async function mintTicket(userId: string, cookie: Cookie): Promise<string> {
  const response = await handleDeletionReauth(
    post('/api/session/delete-account/reauth', { method: 'password', currentPassword: PASSWORD }, cookie),
    { log: () => undefined, allowReauth: () => true },
  )
  assert.equal(response.status, 200, `re-auth should succeed: ${response.status}`)
  const data = (await response.json()) as { ticket?: string }
  assert.ok(data.ticket)
  return data.ticket
}

/**
 * Mint a ticket for an account that no longer exists (the re-auth handlers
 * only need a session, and the session is a cookie we control), so the
 * already-deleted branch can be reached the same way a client would reach it.
 */
async function mintTicketForGoneAccount(userId: string): Promise<string> {
  const response = await handleDeletionReauth(
    post('/api/session/delete-account/reauth', { method: 'password', currentPassword: 'anything' }, 'stub=1'),
    {
      log: () => undefined,
      allowReauth: () => true,
      getSessionUser: async () => ({ id: userId, email: 'gone@example.test' }),
      verifyPassword: async () => true,
    },
  )
  assert.equal(response.status, 200, `stub re-auth should succeed: ${response.status}`)
  const data = (await response.json()) as { ticket?: string }
  assert.ok(data.ticket)
  return data.ticket
}

const created: { users: string[]; workspaces: string[] } = { users: [], workspaces: [] }

async function purge() {
  if (created.workspaces.length > 0) {
    await database.delete(decisionRecords).where(inArray(decisionRecords.workspaceId, created.workspaces))
    await database.delete(projectEvents).where(inArray(projectEvents.workspaceId, created.workspaces))
    await database.delete(approvals).where(inArray(approvals.workspaceId, created.workspaces))
    await database.delete(projectApiKeys).where(inArray(projectApiKeys.workspaceId, created.workspaces))
    await database.delete(invites).where(inArray(invites.workspaceId, created.workspaces))
    await database.delete(projects).where(inArray(projects.workspaceId, created.workspaces))
    await database.delete(memberships).where(inArray(memberships.workspaceId, created.workspaces))
    await database.delete(workspaces).where(inArray(workspaces.id, created.workspaces))
  }
  if (created.users.length > 0) {
    await database.delete(accountSecurityEvents).where(inArray(accountSecurityEvents.userId, created.users))
    await database.delete(passkeys).where(inArray(passkeys.userId, created.users))
    await database.delete(pendingEmailChanges).where(inArray(pendingEmailChanges.userId, created.users))
    await database.delete(pendingEmailVerifications).where(inArray(pendingEmailVerifications.userId, created.users))
    await database.delete(memberships).where(inArray(memberships.userId, created.users))
    await database.delete(users).where(inArray(users.id, created.users))
  }
  await database.delete(verifications).where(eq(verifications.identifier, 'unused'))
}

before(async () => {
  clearSentMail()
})

after(async () => {
  await purge()
})

describe('deletion preview', () => {
  it('requires a session and the app origin', async () => {
    const anonymous = await handleDeletionPreview(get('/preview', ''), { log: () => undefined })
    assert.equal(anonymous.status, 401)

    const foreign = await deleteRoutePOST(
      new Request(`${APP_URL}/api/session/delete-account`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      }) as never,
    )
    assert.equal(foreign.status, 403)

    const wrongType = await reauthRoutePOST(
      new Request(`${APP_URL}/api/session/delete-account/reauth`, {
        method: 'POST',
        headers: { origin: APP_URL, 'content-type': 'text/plain' },
        body: '{}',
      }) as never,
    )
    assert.equal(wrongType.status, 415)
  })

  it('separates delete-with-account, kept, and blocked workspaces with counts', async () => {
    const owner = await signUp('preview-owner')
    const colleague = await signUp('preview-colleague')
    created.users.push(owner.id, colleague.id)

    const soloRows = await database
      .select({ workspaceId: workspaces.id })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, owner.id))
    const soloId = soloRows[0]!.workspaceId
    created.workspaces.push(soloId)
    const soloProject = await makeProject(soloId, 'Solo Project')
    await makeApiKey(soloId, soloProject, 'solo key')
    await makeDecision({ workspaceId: soloId, projectId: soloProject, actorUserId: owner.id, comment: 'ok' })

    const sharedId = await makeWorkspace(colleague.id, 'Shared Team')
    await addMember(sharedId, owner.id, 'member')
    created.workspaces.push(sharedId)
    const sharedProject = await makeProject(sharedId, 'Shared Project')
    await makeApiKey(sharedId, sharedProject, 'shared key')

    const response = await handleDeletionPreview(get('/preview', owner.cookie), { log: () => undefined })
    assert.equal(response.status, 200)
    const preview = (await response.json()) as {
      deletableWorkspaces: Array<{ id: string; projects: number; apiKeys: number; decisions: number }>
      keptWorkspaces: Array<{ id: string; apiKeys: number }>
      hasBlocker: boolean
      exportAvailable: boolean
    }
    const solo = preview.deletableWorkspaces.find((item) => item.id === soloId)
    assert.ok(solo, 'the sole-member workspace must be listed as deletable')
    assert.deepEqual(
      { projects: solo.projects, apiKeys: solo.apiKeys, decisions: solo.decisions },
      { projects: 1, apiKeys: 1, decisions: 1 },
    )
    const kept = preview.keptWorkspaces.find((item) => item.id === sharedId)
    assert.ok(kept, 'the shared workspace must be listed as kept')
    assert.equal(kept.apiKeys, 1)
    assert.equal(preview.hasBlocker, false)
    assert.equal(preview.exportAvailable, true)
  })
})

describe('export', () => {
  it('exports only the sole-member workspaces, redacting secrets', async () => {
    const owner = await signUp('export-owner')
    const colleague = await signUp('export-colleague')
    created.users.push(owner.id, colleague.id)

    const soloRows = await database
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(eq(memberships.userId, owner.id))
    const soloId = soloRows[0]!.workspaceId
    created.workspaces.push(soloId)
    const soloProject = await makeProject(soloId, 'Exportable Project')
    await makeApiKey(soloId, soloProject, 'export key')
    const sharedId = await makeWorkspace(colleague.id, 'Private Shared Team')
    await addMember(sharedId, owner.id, 'member')
    created.workspaces.push(sharedId)
    const sharedProject = await makeProject(sharedId, 'Private Shared Project')
    await makeApiKey(sharedId, sharedProject, 'private key')

    const response = await handleAccountExport(get('/export', owner.cookie), { log: () => undefined })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /attachment/)
    const text = await response.text()
    const payload = JSON.parse(text) as {
      profile: { email: string }
      workspaces: Array<{ id: string; projects: Array<{ name: string; credentials: Record<string, unknown> }>; apiKeys: Array<Record<string, unknown> > }>
      memberships: Array<{ id: string }>
    }
    assert.equal(payload.profile.email, owner.email)
    assert.deepEqual(
      payload.workspaces.map((workspace) => workspace.id),
      [soloId],
      'shared-workspace contents must not be exported',
    )
    assert.equal(payload.workspaces[0]!.projects[0]!.name, 'Exportable Project')
    assert.deepEqual(payload.workspaces[0]!.projects[0]!.credentials, { baseUrl: '[redacted]', token: '[redacted]' })
    assert.ok(!text.includes('super-secret-token'), 'third-party credentials must be redacted')
    assert.ok(!text.includes('hashed-'), 'API key hashes must never be exported')
    assert.ok(!text.includes('Private Shared Project'))
    assert.deepEqual(payload.memberships.map((item) => item.id), [sharedId])
    void sharedProject
  })
})

describe('re-auth', () => {
  it('refuses a missing field, a wrong password, and a spent limiter', async () => {
    const owner = await signUp('reauth-owner')
    created.users.push(owner.id)

    const missing = await handleDeletionReauth(post('/reauth', { method: 'password' }, owner.cookie), {
      log: () => undefined,
    })
    assert.equal(missing.status, 400)

    const wrong = await handleDeletionReauth(
      post('/reauth', { method: 'password', currentPassword: 'not-the-password' }, owner.cookie),
      { log: () => undefined },
    )
    assert.equal(wrong.status, 400)
    assert.equal(((await wrong.json()) as { code?: string }).code, 'INVALID_PASSWORD')

    const throttled = await handleDeletionReauth(
      post('/reauth', { method: 'password', currentPassword: PASSWORD }, owner.cookie),
      { allowReauth: () => false, log: () => undefined },
    )
    assert.equal(throttled.status, 429)

    const anonymous = await handleDeletionReauth(post('/reauth', { method: 'password', currentPassword: PASSWORD }, ''), {
      log: () => undefined,
    })
    assert.equal(anonymous.status, 401)
  })

  it('accepts a user-verified passkey assertion bound to this account', async () => {
    const owner = await signUp('passkey-owner')
    created.users.push(owner.id)
    const credentialId = `cred-${run}`
    await database.insert(passkeys).values({
      id: newId('pk').slice(0, 36),
      name: 'Test key',
      publicKey: 'AAA',
      userId: owner.id,
      credentialID: credentialId,
      counter: 3,
      deviceType: 'platform',
      backedUp: false,
      transports: 'internal',
      aaguid: null,
    })

    // UV flag (bit 0x04 of authenticatorData byte 32) set.
    const authenticatorData = new Uint8Array(37)
    authenticatorData[32] = 0x05
    const toBase64Url = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const assertion = {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
        authenticatorData: toBase64Url(authenticatorData),
        signature: 'AAA',
      },
    }

    const options = await handleDeletionReauthOptions(post('/reauth/options', {}, owner.cookie), {
      log: () => undefined,
      generateAuthenticationOptions: stubGenerateOptions('chal', credentialId),
    })
    assert.equal(options.status, 200)
    const challengeCookie = (options.headers.getSetCookie() ?? [])
      .find((value) => value.startsWith(`${DELETION_CHALLENGE_COOKIE}=`))!
      .split(';')[0]!

    const noUv = { ...assertion, response: { ...assertion.response, authenticatorData: toBase64Url(new Uint8Array(37)) } }
    const refused = await handleDeletionReauth(post('/reauth', { method: 'passkey', response: noUv }, `${owner.cookie}; ${challengeCookie}`), {
      log: () => undefined,
      verifyAuthenticationResponse: stubVerify(credentialId, 7),
    })
    assert.equal(refused.status, 400)
    assert.equal(((await refused.json()) as { code?: string }).code, 'USER_VERIFICATION_REQUIRED')

    const accepted = await handleDeletionReauth(post('/reauth', { method: 'passkey', response: assertion }, `${owner.cookie}; ${challengeCookie}`), {
      log: () => undefined,
      verifyAuthenticationResponse: stubVerify(credentialId, 7),
    })
    // The challenge is single-use: the UV-less attempt above consumed it, so
    // start a fresh one for the accepted case.
    if (accepted.status !== 200) {
      const retryOptions = await handleDeletionReauthOptions(post('/reauth/options', {}, owner.cookie), {
        log: () => undefined,
        generateAuthenticationOptions: stubGenerateOptions('chal', credentialId),
      })
      const freshCookie = (retryOptions.headers.getSetCookie() ?? [])
        .find((value) => value.startsWith(`${DELETION_CHALLENGE_COOKIE}=`))!
        .split(';')[0]!
      const retried = await handleDeletionReauth(
        post('/reauth', { method: 'passkey', response: assertion }, `${owner.cookie}; ${freshCookie}`),
        {
          log: () => undefined,
          verifyAuthenticationResponse: stubVerify(credentialId, 7),
        },
      )
      assert.equal(retried.status, 200)
      const data = (await retried.json()) as { ticket?: string }
      assert.ok(data.ticket)
    } else {
      const data = (await accepted.json()) as { ticket?: string }
      assert.ok(data.ticket)
    }

    // A verification that reports failure never mints a ticket.
    const failingOptions = await handleDeletionReauthOptions(post('/reauth/options', {}, owner.cookie), {
      log: () => undefined,
      generateAuthenticationOptions: stubGenerateOptions('chal', credentialId),
    })
    const failCookie = (failingOptions.headers.getSetCookie() ?? [])
      .find((value) => value.startsWith(`${DELETION_CHALLENGE_COOKIE}=`))!
      .split(';')[0]!
    const failing = await handleDeletionReauth(
      post('/reauth', { method: 'passkey', response: assertion }, `${owner.cookie}; ${failCookie}`),
      {
        log: () => undefined,
        verifyAuthenticationResponse: stubVerify(credentialId, 0, false),
      },
    )
    assert.equal(failing.status, 400)
  })

  it('refuses an assertion for a credential the user does not own', async () => {
    const owner = await signUp('passkey-stranger')
    created.users.push(owner.id)
    const authenticatorData = new Uint8Array(37)
    authenticatorData[32] = 0x05
    const toBase64Url = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const assertion = {
      id: 'cred-someone-else',
      rawId: 'cred-someone-else',
      type: 'public-key' as const,
      response: {
        clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
        authenticatorData: toBase64Url(authenticatorData),
        signature: 'AAA',
      },
    }
    // The user has a passkey, so options are issued; the credential in the
    // assertion belongs to nobody, so verification must not run and no ticket
    // is minted.
    await database.insert(passkeys).values({
      id: newId('pk').slice(0, 36),
      name: 'Real key',
      publicKey: 'AAA',
      userId: owner.id,
      credentialID: `cred-owned-${run}`,
      counter: 0,
      deviceType: 'platform',
      backedUp: false,
      transports: null,
      aaguid: null,
    })
    const options = await handleDeletionReauthOptions(post('/reauth/options', {}, owner.cookie), {
      log: () => undefined,
      generateAuthenticationOptions: stubGenerateOptions('chal-x', `cred-owned-${run}`),
    })
    const cookie = (options.headers.getSetCookie() ?? [])
      .find((value) => value.startsWith(`${DELETION_CHALLENGE_COOKIE}=`))!
      .split(';')[0]!
    let verifierRan = false
    const response = await handleDeletionReauth(
      post('/reauth', { method: 'passkey', response: assertion }, `${owner.cookie}; ${cookie}`),
      {
        log: () => undefined,
        verifyAuthenticationResponse: async () => {
          verifierRan = true
          return { verified: true, authenticationInfo: { credentialID: 'x', newCounter: 1, userVerified: true, credentialDeviceType: 'singleDevice' as const, credentialBackedUp: false, origin: APP_URL, rpID: 'localhost' } }
        },
      },
    )
    assert.equal(response.status, 400)
    assert.equal(verifierRan, false, 'an unowned credential must never reach the verifier')
  })
})

describe('deletion guards', () => {
  it('refuses without the typed confirmation, and the ticket survives the refusal', async () => {
    const owner = await signUp('guard-confirm')
    created.users.push(owner.id)
    const ticket = await mintTicket(owner.id, owner.cookie)

    const wrong = await handleAccountDeletion(post('/delete', { confirmation: 'delete', ticket }, owner.cookie), {
      log: () => undefined,
    })
    assert.equal(wrong.status, 400)
    assert.equal(((await wrong.json()) as { code?: string }).code, 'CONFIRMATION_MISMATCH')

    const missingTicket = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE' }, owner.cookie), {
      log: () => undefined,
    })
    assert.equal(missingTicket.status, 412)

    // The earlier refusal did not spend the ticket, so the right call works.
    const ok = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket }, owner.cookie), {
      log: () => undefined,
      notifyDeleted: async () => undefined,
      notifyApiKeyReview: async () => undefined,
    })
    assert.equal(ok.status, 200)
    assert.equal(await userRow(owner.id), null)
  })

  it('spends the ticket: a replay is refused', async () => {
    const owner = await signUp('guard-replay')
    created.users.push(owner.id)
    const ticket = await mintTicket(owner.id, owner.cookie)
    const first = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket }, owner.cookie), {
      log: () => undefined,
      notifyDeleted: async () => undefined,
      notifyApiKeyReview: async () => undefined,
    })
    assert.equal(first.status, 200)

    // The spent ticket is worthless.
    const replay = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket }, ''), {
      log: () => undefined,
      getSessionUser: async () => ({ id: owner.id, email: owner.email }),
    })
    assert.equal(replay.status, 412)

    // A fresh ticket on an account that is already gone answers idempotently.
    const secondTicket = await mintTicketForGoneAccount(owner.id)
    const again = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket: secondTicket }, ''), {
      log: () => undefined,
      getSessionUser: async () => ({ id: owner.id, email: owner.email }),
    })
    assert.equal(again.status, 200)
    assert.equal(((await again.json()) as { alreadyDeleted?: boolean }).alreadyDeleted, true)

    // ...and a third call behaves the same.
    const thirdTicket = await mintTicketForGoneAccount(owner.id)
    const third = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket: thirdTicket }, ''), {
      log: () => undefined,
      getSessionUser: async () => ({ id: owner.id, email: owner.email }),
    })
    assert.equal(third.status, 200)
    assert.equal(((await third.json()) as { alreadyDeleted?: boolean }).alreadyDeleted, true)
  })

  it('refuses a ticket minted for another account', async () => {
    const alice = await signUp('guard-alice')
    const bob = await signUp('guard-bob')
    created.users.push(alice.id, bob.id)
    const aliceTicket = await mintTicket(alice.id, alice.cookie)

    const stolen = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket: aliceTicket }, bob.cookie), {
      log: () => undefined,
    })
    assert.equal(stolen.status, 412)
    assert.ok(await userRow(alice.id), 'the real owner must survive')
    assert.ok(await userRow(bob.id), 'the attacker account must survive')

    // The stolen ticket is consumed, so Alice cannot use it either.
    const spent = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket: aliceTicket }, alice.cookie), {
      log: () => undefined,
    })
    assert.equal(spent.status, 412)
  })
})

describe('blockers', () => {
  it('refuses a sole owner of a shared workspace and deletes nothing', async () => {
    const owner = await signUp('block-owner')
    const colleague = await signUp('block-colleague')
    created.users.push(owner.id, colleague.id)
    const sharedId = await makeWorkspace(owner.id, 'Blocked Team')
    await addMember(sharedId, colleague.id, 'member')
    created.workspaces.push(sharedId)

    const ticket = await mintTicket(owner.id, owner.cookie)
    const response = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket }, owner.cookie), {
      log: () => undefined,
    })
    assert.equal(response.status, 409)
    const body = (await response.json()) as { code?: string }
    assert.equal(body.code, 'SOLE_OWNER_OF_SHARED_WORKSPACE')
    assert.ok(await userRow(owner.id), 'a blocked deletion must not delete the account')
    const stillThere = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, sharedId))
    assert.equal(stillThere.length, 1)
  })

  it('refuses while a paid subscription the user owns is active', async () => {
    const owner = await signUp('block-paid')
    created.users.push(owner.id)
    const rows = await database
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(eq(memberships.userId, owner.id))
    const soloId = rows[0]!.workspaceId
    created.workspaces.push(soloId)
    await database.update(workspaces).set({ plan: 'pro', stripeSubscriptionId: 'sub_test_1' }).where(eq(workspaces.id, soloId))

    const ticket = await mintTicket(owner.id, owner.cookie)
    const response = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket }, owner.cookie), {
      log: () => undefined,
    })
    assert.equal(response.status, 409)
    const body = (await response.json()) as { code?: string; message?: string }
    assert.equal(body.code, 'ACTIVE_SUBSCRIPTION')
    assert.match(body.message ?? '', /Cancel your subscription first/)
    assert.ok(await userRow(owner.id))
  })
})

describe('deletion cascade and anonymisation', () => {
  it('destroys what belongs to the account and anonymises what stays', async () => {
    const owner = await signUp('cascade-owner')
    const colleague = await signUp('cascade-colleague')
    created.users.push(owner.id, colleague.id)

    // --- the account's own workspace, deleted with it
    const soloRows = await database
      .select({ workspaceId: memberships.workspaceId })
      .from(memberships)
      .where(eq(memberships.userId, owner.id))
    const soloId = soloRows[0]!.workspaceId
    created.workspaces.push(soloId)
    const soloProject = await makeProject(soloId, 'Cascade Solo Project')
    const soloKey = await makeApiKey(soloId, soloProject, 'solo key')
    const soloDecision = await makeDecision({
      workspaceId: soloId,
      projectId: soloProject,
      actorUserId: owner.id,
      comment: 'solo comment',
    })

    // --- a shared workspace that must survive, with a decision to anonymise
    const sharedId = await makeWorkspace(colleague.id, 'Cascade Shared Team')
    await addMember(sharedId, owner.id, 'member')
    created.workspaces.push(sharedId)
    const sharedProject = await makeProject(sharedId, 'Cascade Shared Project')
    const sharedKey = await makeApiKey(sharedId, sharedProject, 'shared key')
    const sharedDecision = await makeDecision({
      workspaceId: sharedId,
      projectId: sharedProject,
      actorUserId: owner.id,
      comment: 'KEEP ME VERBATIM: the refund looked legitimate, approved.',
      client: {
        actor: { kind: 'human', id: owner.id, display: owner.email },
        client: { channel: 'web', userAgent: 'Mozilla/5.0 (Macintosh)', appVersion: '1.2.3' },
      },
    })
    await database.insert(projectEvents).values({
      id: newId('evt').slice(0, 36),
      workspaceId: sharedId,
      projectId: sharedProject,
      approvalId: sharedDecision.approvalId,
      level: 'info',
      type: 'decided',
      message: 'decided',
      payload: {},
    })

    // --- user-scoped rows that must go or be rewritten
    await database.insert(pendingEmailChanges).values({
      id: newId('eml').slice(0, 36),
      userId: owner.id,
      pendingEmail: `pending-${run}@${emailDomain}`,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await database.delete(pendingEmailVerifications).where(eq(pendingEmailVerifications.userId, owner.id))
    await database.insert(pendingEmailVerifications).values({
      id: newId('emv').slice(0, 36),
      userId: owner.id,
      email: owner.email,
      tokenHash: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await database.insert(invites).values({
      id: newId('inv').slice(0, 36),
      workspaceId: sharedId,
      email: owner.email,
      role: 'member',
      invitedByUserId: colleague.id,
      tokenHash: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await database.insert(invites).values({
      id: newId('inv').slice(0, 36),
      workspaceId: sharedId,
      email: `someone-else-${run}@${emailDomain}`,
      role: 'member',
      invitedByUserId: owner.id,
      tokenHash: 'd'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await database.insert(accountSecurityEvents).values({ id: newId('sec').slice(0, 36), userId: owner.id, type: 'mfa_enabled' })

    const notices: Array<{ to: string; workspaceName?: string }> = []
    const deletions: string[] = []
    const ticket = await mintTicket(owner.id, owner.cookie)
    const response = await handleAccountDeletion(
      post('/delete', { confirmation: 'DELETE', ticket }, owner.cookie, { 'x-forwarded-for': '203.0.113.84' }),
      {
        log: () => undefined,
        notifyDeleted: async ({ to }) => {
          deletions.push(to)
        },
        notifyApiKeyReview: async ({ to, workspaceName }) => {
          notices.push({ to, workspaceName })
        },
      },
    )
    assert.equal(response.status, 200)
    const reply = (await response.json()) as { ok?: boolean; alreadyDeleted?: boolean }
    assert.equal(reply.ok, true)
    assert.equal(reply.alreadyDeleted, false)

    // gone
    assert.equal(await userRow(owner.id), null)
    assert.equal((await database.select().from(sessions).where(eq(sessions.userId, owner.id))).length, 0)
    assert.equal((await database.select().from(memberships).where(eq(memberships.userId, owner.id))).length, 0)
    assert.equal((await database.select().from(workspaces).where(eq(workspaces.id, soloId))).length, 0)
    assert.equal((await database.select().from(projects).where(eq(projects.id, soloProject))).length, 0)
    assert.equal((await database.select().from(projectApiKeys).where(eq(projectApiKeys.id, soloKey))).length, 0)
    assert.equal(
      (await database.select().from(decisionRecords).where(eq(decisionRecords.id, soloDecision.id))).length,
      0,
    )
    assert.equal((await database.select().from(pendingEmailChanges).where(eq(pendingEmailChanges.userId, owner.id))).length, 0)
    assert.equal(
      (await database.select().from(pendingEmailVerifications).where(eq(pendingEmailVerifications.userId, owner.id))).length,
      0,
    )
    assert.equal((await database.select().from(invites).where(eq(invites.email, owner.email))).length, 0)

    // kept
    assert.equal((await database.select().from(workspaces).where(eq(workspaces.id, sharedId))).length, 1)
    assert.equal((await database.select().from(projects).where(eq(projects.id, sharedProject))).length, 1)
    assert.equal((await database.select().from(projectApiKeys).where(eq(projectApiKeys.id, sharedKey))).length, 1)
    assert.equal(
      (await database.select().from(invites).where(eq(invites.email, `someone-else-${run}@${emailDomain}`))).length,
      1,
      'invites addressed to others survive',
    )
    assert.ok(await userRow(colleague.id), 'the colleague account is untouched')

    // anonymised decision record: identity gone, comment verbatim
    const [record] = await database.select().from(decisionRecords).where(eq(decisionRecords.id, sharedDecision.id))
    assert.ok(record)
    assert.equal(record.actorUserId, null)
    const client = record.client as Record<string, unknown>
    assert.deepEqual(client.actor, { kind: 'human', display: 'Deleted user' })
    assert.deepEqual(client.client, { channel: 'web' })
    const raw = JSON.stringify(record.client)
    assert.ok(!raw.includes(owner.id), 'the reviewer id must be gone')
    assert.ok(!raw.includes(owner.email), 'the reviewer email must be gone')
    assert.ok(!raw.includes('Mozilla'), 'the device user agent must be gone')
    assert.ok(!raw.includes('1.2.3'), 'the app version must be gone')
    const payloadText = JSON.stringify(record.payload)
    assert.ok(payloadText.includes('KEEP ME VERBATIM'), 'the reviewer comment text is kept verbatim')

    // anonymised security events: HMAC'd, IP truncated, dated, still there
    const ownHmac = securityEventHmac(resolveSecurityEventHmacKey(process.env), owner.email)
    const events = await database
      .select()
      .from(accountSecurityEvents)
      .where(and(isNull(accountSecurityEvents.userId), eq(accountSecurityEvents.emailHmac, ownHmac)))
    const types = events.map((event) => event.type)
    assert.ok(types.includes('mfa_enabled'), 'the pre-existing event survives, anonymised')
    assert.ok(types.includes(ACCOUNT_DELETION_SECURITY_EVENT), 'the deletion itself is recorded')
    const anonymised = events.find((event) => event.type === 'mfa_enabled')!
    assert.equal(anonymised.userId, null)
    assert.match(anonymised.userIdHmac ?? '', /^[0-9a-f]{64}$/)
    assert.match(anonymised.emailHmac ?? '', /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(anonymised).includes(owner.email), 'no plain email in the anonymised row')
    assert.equal(anonymised.ipTruncated, '203.0.113.0', 'the client address is truncated to its /24')
    const retentionDays =
      (anonymised.retentionExpiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    assert.ok(retentionDays > 88 && retentionDays <= 91, `retention should be ~90 days, got ${retentionDays}`)

    // notices
    assert.deepEqual(deletions, [owner.email], 'one confirmation to the deleted address')
    assert.ok(
      notices.some((notice) => notice.to === colleague.email && notice.workspaceName === 'Cascade Shared Team'),
      'the surviving workspace admin is asked to review API keys',
    )

    // cookies expired
    const setCookies = response.headers.getSetCookie().join('\n')
    assert.match(setCookies, /better-auth\.session_token=/)
    assert.match(setCookies, /Max-Age=0/)
  })

  it('sends the branded confirmation (permanent) and the API-key review notice', async () => {
    const owner = await signUp('mail-owner')
    const colleague = await signUp('mail-colleague')
    created.users.push(owner.id, colleague.id)
    const sharedId = await makeWorkspace(colleague.id, 'Mail Team')
    await addMember(sharedId, owner.id, 'member')
    created.workspaces.push(sharedId)

    clearSentMail()
    const ticket = await mintTicket(owner.id, owner.cookie)
    const response = await handleAccountDeletion(post('/delete', { confirmation: 'DELETE', ticket }, owner.cookie), {
      log: () => undefined,
    })
    assert.equal(response.status, 200)

    let messages = sentMail.slice()
    for (let attempt = 0; attempt < 50 && messages.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      messages = sentMail.slice()
    }
    const deletion = messages.find((message) => message.to === owner.email)
    const review = messages.find((message) => message.to === colleague.email)
    assert.ok(deletion, 'the deleted address is emailed')
    assert.match(deletion!.subject, /deleted/i)
    assert.match(deletion!.text, /permanent/i)
    assert.ok(!/https?:\/\//.test(deletion!.text), 'the confirmation carries no link')
    assert.ok(review, 'the workspace admin is emailed')
    assert.match(review!.subject, /review your API keys/i)
    assert.match(review!.text, /Mail Team/)
  })
})
