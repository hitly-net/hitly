/**
 * Workspace invite accept flow against real Postgres and the app's real
 * Better Auth instance: tokenised accept link, signup-off bypass only for the
 * invited email with a valid token, single use, expiry, email binding, races,
 * and no token in logs.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'
process.env.HITLY_SIGNUP_ENABLED = '0'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, describe, it, mock } from 'node:test'
import { and, eq, inArray, like } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { accounts, invites, memberships, sessions, users, workspaces } from '@hitly/db/schema'
import { clearSentMail, sentMail } from '@hitly/mail'
import { auth } from './auth'
import { db, pool } from './db'
import { newId } from './ids'
import { inviteRouteDeps } from './invite-route-deps'
import { runWithInviteSignup } from './invite-signup'
import { handleInviteAccept, handleInviteLookup } from './invite-routes'
import {
  INVITE_TTL_DAYS,
  INVITE_TTL_MS,
  acceptInviteAsUser,
  acceptInviteWithNewAccount,
  buildInviteUrl,
  claimInvite,
  lookupInvite,
  releaseInvite,
  createAndSendWorkspaceInvite,
  generateInviteToken,
  hashInviteToken,
  resendWorkspaceInvite,
  revokeWorkspaceInvite,
} from './invites'

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const emailDomain = `invite-${run}.example.com`
const workspaceId = newId('ws').slice(0, 36)
const adminId = newId('usr').slice(0, 36)

// Every log line and stdout/stderr write during the run, to prove tokens never appear.
const logged: string[] = []
const tokensSeen: string[] = []
const restore: Array<() => void> = []

function capture() {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level]
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
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

/** Invites `address` through the real create-and-send path and returns the token from the email. */
async function invite(address: string, role: 'admin' | 'member' = 'member') {
  clearSentMail()
  await createAndSendWorkspaceInvite({
    workspaceId,
    workspaceName: 'Invite Co',
    email: address,
    role,
    invitedByUserId: adminId,
    appUrl: APP_URL,
  })
  assert.equal(sentMail.length, 1)
  const match = sentMail[0].text.match(/\/invite\/([A-Za-z0-9_-]{43})/)
  assert.ok(match, 'invite email must contain the accept link')
  tokensSeen.push(match[1])
  return match[1]
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(new URL(path, APP_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(APP_URL).origin, ...headers },
    body: JSON.stringify(body),
  })
}

const accept = (body: unknown, headers?: Record<string, string>) =>
  handleInviteAccept(jsonRequest('/api/v1/invites/accept', body, headers), inviteRouteDeps)
const lookup = (body: unknown, headers?: Record<string, string>) =>
  handleInviteLookup(jsonRequest('/api/v1/invites/lookup', body, headers), inviteRouteDeps)

/** Creates an account the ordinary way (public signup briefly on) and returns a session cookie header. */
async function existingUserCookie(address: string, name = 'Existing User') {
  process.env.HITLY_SIGNUP_ENABLED = '1'
  try {
    await authApi.signUpEmail({ body: { email: address, name, password: 'correct-horse-battery' } })
  } finally {
    process.env.HITLY_SIGNUP_ENABLED = '0'
  }
  return signInCookie(address)
}

async function signInCookie(address: string, password = 'correct-horse-battery') {
  const { headers } = await authApi.signInEmail({
    body: { email: address, password },
    returnHeaders: true,
  })
  return headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

async function userByEmail(address: string) {
  const rows = await database.select().from(users).where(eq(users.email, address.toLowerCase())).limit(1)
  return rows[0] ?? null
}

async function membership(userId: string) {
  const rows = await database
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
  return rows[0] ?? null
}

async function inviteRow(token: string) {
  const rows = await database.select().from(invites).where(eq(invites.tokenHash, hashInviteToken(token))).limit(1)
  return rows[0] ?? null
}

before(async () => {
  capture()
  await database.insert(workspaces).values({ id: workspaceId, name: 'Invite Co', slug: `invite-co-${run}` })
  await database.insert(users).values({
    id: adminId,
    email: email('admin'),
    name: 'Admin',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await database.insert(memberships).values({ id: newId('mem').slice(0, 36), workspaceId, userId: adminId, role: 'owner' })
})

beforeEach(() => {
  process.env.HITLY_SIGNUP_ENABLED = '0'
})

after(async () => {
  for (const undo of restore.reverse()) undo()
  const created = await database.select({ id: users.id }).from(users).where(like(users.email, `%@${emailDomain}`))
  const ids = created.map((u) => u.id)
  const owned = ids.length
    ? await database.select({ id: memberships.workspaceId }).from(memberships).where(and(inArray(memberships.userId, ids), eq(memberships.role, 'owner')))
    : []
  await database.delete(invites).where(eq(invites.workspaceId, workspaceId))
  if (ids.length) {
    await database.delete(memberships).where(inArray(memberships.userId, ids))
    await database.delete(sessions).where(inArray(sessions.userId, ids))
    await database.delete(accounts).where(inArray(accounts.userId, ids))
  }
  const wsIds = [...new Set([workspaceId, ...owned.map((o) => o.id)])]
  await database.delete(workspaces).where(inArray(workspaces.id, wsIds))
  if (ids.length) await database.delete(users).where(inArray(users.id, ids))
  await pool?.end()
})

describe('invite email and token storage', () => {
  it('emails a tokenised accept link on the configured app URL and stores only the hash', async () => {
    const address = email('mail')
    const token = await invite(address)
    const message = sentMail[0]
    assert.equal(message.to, address)
    assert.ok(message.text.includes(`${APP_URL}/invite/${token}`), 'email links to <app>/invite/<token>')
    assert.equal(buildInviteUrl(APP_URL, token), `${APP_URL}/invite/${token}`)
    assert.ok(message.text.includes("You've been invited to join Invite Co on HITLy."), 'branded invitation wording')
    assert.ok(message.html?.includes('Open in HITLy'), 'branded HTML with the primary button')
    assert.ok(!message.text.includes('/signup'), 'no bare signup link')
    assert.match(message.text, new RegExp(`expires in ${INVITE_TTL_DAYS} days`))

    const row = await inviteRow(token)
    assert.ok(row)
    assert.equal(row.tokenHash, createHash('sha256').update(token).digest('hex'))
    assert.ok(!JSON.stringify(row).includes(token), 'raw token is not stored')
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime()
    assert.ok(Math.abs(ttl - INVITE_TTL_MS) < 60_000, 'expiry is the stated TTL')
  })

  it('tokens are 256-bit and unique', () => {
    const a = generateInviteToken()
    const b = generateInviteToken()
    assert.equal(Buffer.from(a, 'base64url').length, 32)
    assert.notEqual(a, b)
  })

  it('inviting the same email again replaces the earlier link', async () => {
    const address = email('reinvite')
    const first = await invite(address)
    const second = await invite(address)
    assert.equal(await inviteRow(first), null)
    assert.ok(await inviteRow(second))
    const response = await lookup({ token: first })
    assert.equal(response.status, 404)
  })
})

describe('new user accepts with public signup off', () => {
  it('creates the account for the invited email only and joins the workspace', async () => {
    const address = email('newbie')
    const token = await invite(address, 'admin')

    const info = await lookup({ token })
    assert.equal(info.status, 200)
    const body = (await info.json()) as Record<string, unknown>
    assert.equal(body.workspaceName, 'Invite Co')
    assert.equal(body.email, address)
    assert.equal(body.accountExists, false)
    assert.equal(body.signedInEmail, null)

    const response = await accept({ token, name: 'New Person', password: 'a-strong-password' })
    assert.equal(response.status, 200, await response.clone().text())
    const cookies = response.headers.getSetCookie().join('\n')
    assert.match(cookies, /better-auth\.session_token=/, 'signed in after accepting')
    assert.match(cookies, new RegExp(`hitly-workspace-id=${workspaceId}`))

    const user = await userByEmail(address)
    assert.ok(user)
    assert.equal(user.emailVerified, true)
    assert.equal((await membership(user.id))?.role, 'admin')
    assert.ok((await inviteRow(token))?.acceptedAt, 'invite is marked used')
  })

  it('signup stays closed without a token, even for an invited email', async () => {
    const address = email('pending')
    await invite(address)
    await assert.rejects(
      () => authApi.signUpEmail({ body: { email: address, name: 'No Token', password: 'a-strong-password' } }),
      /disabled/i,
    )
    await assert.rejects(
      () => authApi.signUpEmail({ body: { email: email('stranger'), name: 'Stranger', password: 'a-strong-password' } }),
      /disabled/i,
    )
    assert.equal(await userByEmail(address), null)
    assert.equal(await userByEmail(email('stranger')), null)
  })

  it('refuses a new account when one already exists for the invited email', async () => {
    const address = email('already')
    await existingUserCookie(address)
    const token = await invite(address)
    const response = await accept({ token, name: 'Dup', password: 'a-strong-password' })
    assert.equal(response.status, 409)
    assert.equal((await inviteRow(token))?.acceptedAt, null, 'invite not consumed')
  })

  it('releases the invite when account creation fails, so the link can be retried', async () => {
    const address = email('retry')
    const token = await invite(address)
    const tooShort = await accept({ token, name: 'Retry', password: 'short' })
    assert.equal(tooShort.status, 400)
    const tooLong = await accept({ token, name: 'Retry', password: 'x'.repeat(200) })
    assert.equal(tooLong.status, 400)
    assert.equal((await inviteRow(token))?.acceptedAt, null)
    assert.equal(await userByEmail(address), null)
    const ok = await accept({ token, name: 'Retry', password: 'a-strong-password' })
    assert.equal(ok.status, 200)
  })
})

describe('existing user signs in and joins', () => {
  it('joins when the signed-in email matches (case-insensitive)', async () => {
    const address = email('member')
    const cookie = await existingUserCookie(address)
    const token = await invite(address.toUpperCase())
    const info = (await (await lookup({ token }, { cookie })).json()) as Record<string, unknown>
    assert.equal(info.accountExists, true)
    assert.equal(info.emailMatches, true)

    const response = await accept({ token }, { cookie })
    assert.equal(response.status, 200)
    const user = await userByEmail(address)
    assert.ok(user)
    assert.equal((await membership(user.id))?.role, 'member')
  })

  it('refuses a signed-in user whose email does not match, without consuming the invite', async () => {
    const invited = email('invited')
    const other = email('other')
    const cookie = await existingUserCookie(other)
    const token = await invite(invited)
    const response = await accept({ token }, { cookie })
    assert.equal(response.status, 403)
    assert.match(((await response.json()) as { error: string }).error, /different email/)
    const otherUser = await userByEmail(other)
    assert.equal(await membership(otherUser!.id), null)
    assert.equal((await inviteRow(token))?.acceptedAt, null)

    const invitedCookie = await existingUserCookie(invited)
    assert.equal((await accept({ token }, { cookie: invitedCookie })).status, 200)
  })
})

describe('refusals', () => {
  it('refuses an expired token', async () => {
    const address = email('late')
    const token = await invite(address)
    await database.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.tokenHash, hashInviteToken(token)))
    const info = await lookup({ token })
    assert.equal(info.status, 410)
    assert.match(((await info.json()) as { error: string }).error, /expired/)
    const response = await accept({ token, name: 'Late', password: 'a-strong-password' })
    assert.equal(response.status, 410)
    assert.equal(await userByEmail(address), null)
  })

  it('refuses reuse of a used token', async () => {
    const address = email('twice')
    const token = await invite(address)
    assert.equal((await accept({ token, name: 'Twice', password: 'a-strong-password' })).status, 200)
    const again = await accept({ token, name: 'Twice', password: 'a-strong-password' })
    assert.equal(again.status, 410)
    assert.match(((await again.json()) as { error: string }).error, /already been used/)
    const cookie = await signInCookie(address, 'a-strong-password')
    assert.equal((await accept({ token }, { cookie })).status, 410)
  })

  it('refuses unknown and malformed tokens', async () => {
    for (const token of [generateInviteToken(), 'short', '', null, '../etc', 'a'.repeat(500)]) {
      const response = await accept({ token, name: 'Nobody', password: 'a-strong-password' })
      assert.equal(response.status, 404, `token ${String(token).slice(0, 10)}`)
      assert.equal((await lookup({ token })).status, 404)
    }
  })

  it('refuses cross-site and non-JSON requests', async () => {
    const token = await invite(email('csrf'))
    const crossSite = await handleInviteAccept(
      jsonRequest('/api/v1/invites/accept', { token, name: 'X', password: 'a-strong-password' }, { origin: 'https://evil.example' }),
      inviteRouteDeps,
    )
    assert.equal(crossSite.status, 403)
    const form = await handleInviteAccept(
      new Request(new URL('/api/v1/invites/accept', APP_URL), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token }) }),
      inviteRouteDeps,
    )
    assert.equal(form.status, 415)
    assert.equal((await inviteRow(token))?.acceptedAt, null)
  })

  it('a pending invite is not applied by email match alone', async () => {
    const address = email('emailonly')
    await invite(address)
    process.env.HITLY_SIGNUP_ENABLED = '1'
    await authApi.signUpEmail({ body: { email: address, name: 'Email Only', password: 'a-strong-password' } })
    process.env.HITLY_SIGNUP_ENABLED = '0'
    const user = await userByEmail(address)
    assert.ok(user)
    assert.equal(await membership(user.id), null)
  })
})

/** Runs Better Auth's real sign-up with an invite token in play, as the accept route does. */
async function signUpWithToken(token: string, address: string) {
  const context = { token, claimed: null, refusal: null as string | null }
  try {
    await runWithInviteSignup(context, () =>
      authApi.signUpEmail({ body: { email: address, name: 'Hook', password: 'a-strong-password' } }),
    )
    return { ok: true as const, context }
  } catch (error) {
    return { ok: false as const, context, message: (error as Error).message }
  }
}

describe('user-create hook validates the token server-side', () => {
  it('lets the invited email through with signup off and consumes the token', async () => {
    const address = email('hook')
    const token = await invite(address)
    const result = await signUpWithToken(token, address)
    assert.equal(result.ok, true)
    assert.ok(result.context.claimed)
    assert.ok((await inviteRow(token))?.acceptedAt)
    assert.ok(await userByEmail(address))
  })

  it('refuses a token used for a different email', async () => {
    const token = await invite(email('bound'))
    const result = await signUpWithToken(token, email('impostor'))
    assert.equal(result.ok, false)
    assert.equal(result.context.refusal, 'wrong_email')
    assert.match(result.message ?? '', /different email/)
    assert.equal(await userByEmail(email('impostor')), null)
    assert.equal((await inviteRow(token))?.acceptedAt, null)
  })

  it('refuses expired, used, revoked and unknown tokens with their own errors', async () => {
    const expiredToken = await invite(email('hook-expired'))
    await database.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.tokenHash, hashInviteToken(expiredToken)))
    const expired = await signUpWithToken(expiredToken, email('hook-expired'))
    assert.equal(expired.context.refusal, 'expired')
    assert.match(expired.message ?? '', /expired/)

    const usedToken = await invite(email('hook-used'))
    assert.equal((await signUpWithToken(usedToken, email('hook-used'))).ok, true)
    // A used token is reported as used, whoever tries it.
    const used = await signUpWithToken(usedToken, email('hook-used-2'))
    assert.equal(used.context.refusal, 'used')
    assert.match(used.message ?? '', /already been used/)

    const revokedToken = await invite(email('hook-revoked'))
    const row = await inviteRow(revokedToken)
    assert.ok(await revokeWorkspaceInvite({ workspaceId, inviteId: row!.id }))
    const revoked = await signUpWithToken(revokedToken, email('hook-revoked'))
    assert.equal(revoked.context.refusal, 'invalid')
    assert.match(revoked.message ?? '', /revoked/)

    const unknown = await signUpWithToken(generateInviteToken(), email('hook-unknown'))
    assert.equal(unknown.context.refusal, 'invalid')
    for (const address of ['hook-expired', 'hook-used-2', 'hook-revoked', 'hook-unknown']) {
      assert.equal(await userByEmail(email(address)), null, address)
    }
  })

  it('a used token is refused for the same email too', async () => {
    const address = email('hook-again')
    const token = await invite(address)
    const accepted = await accept({ token, name: 'Again', password: 'a-strong-password' })
    assert.equal(accepted.status, 200)
    await database.delete(memberships).where(eq(memberships.userId, (await userByEmail(address))!.id))
    await database.delete(sessions).where(eq(sessions.userId, (await userByEmail(address))!.id))
    await database.delete(accounts).where(eq(accounts.userId, (await userByEmail(address))!.id))
    await database.delete(users).where(eq(users.email, address))
    const again = await signUpWithToken(token, address)
    assert.equal(again.context.refusal, 'used')
    assert.match(again.message ?? '', /already been used/)
  })
})

describe('revoke and resend', () => {
  it('a revoked (deleted) invite link is refused', async () => {
    const address = email('revoked')
    const token = await invite(address)
    const row = await inviteRow(token)
    assert.ok(await revokeWorkspaceInvite({ workspaceId, inviteId: row!.id }))
    const response = await accept({ token, name: 'Revoked', password: 'a-strong-password' })
    assert.equal(response.status, 404)
    assert.match(((await response.json()) as { error: string }).error, /revoked/)
    assert.equal(await userByEmail(address), null)
  })

  it('revoke is scoped to the workspace', async () => {
    const token = await invite(email('scoped'))
    const row = await inviteRow(token)
    assert.equal(await revokeWorkspaceInvite({ workspaceId: 'ws_other', inviteId: row!.id }), false)
    assert.ok(await inviteRow(token))
  })

  it('resend gives a pre-token invite a working link', async () => {
    const address = email('legacy')
    const inviteId = newId('inv').slice(0, 36)
    await database.insert(invites).values({
      id: inviteId,
      workspaceId,
      email: address,
      role: 'member',
      invitedByUserId: adminId,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    clearSentMail()
    const result = await resendWorkspaceInvite({ workspaceId, workspaceName: 'Invite Co', inviteId, appUrl: APP_URL })
    assert.equal(result.ok, true)
    assert.equal(sentMail.length, 1)
    assert.equal(sentMail[0].to, address)
    const token = sentMail[0].text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1]
    assert.ok(token)
    tokensSeen.push(token)
    assert.equal((await accept({ token, name: 'Legacy', password: 'a-strong-password' })).status, 200)
  })

  it('resend invalidates the old token and resets the expiry', async () => {
    const address = email('resend')
    const oldToken = await invite(address)
    const row = await inviteRow(oldToken)
    await database.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, row!.id))
    clearSentMail()
    const result = await resendWorkspaceInvite({ workspaceId, workspaceName: 'Invite Co', inviteId: row!.id, appUrl: APP_URL })
    assert.equal(result.ok, true)
    const newToken = sentMail[0].text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1]
    assert.ok(newToken)
    tokensSeen.push(newToken)
    assert.notEqual(newToken, oldToken)
    assert.equal((await lookup({ token: oldToken })).status, 404)
    const fresh = await inviteRow(newToken)
    assert.ok(fresh!.expiresAt.getTime() > Date.now() + INVITE_TTL_MS - 60_000)
    assert.equal((await accept({ token: newToken, name: 'Resent', password: 'a-strong-password' })).status, 200)
  })

  it('resend refuses accepted invites and other workspaces', async () => {
    const address = email('resend-used')
    const token = await invite(address)
    const row = await inviteRow(token)
    assert.equal((await accept({ token, name: 'Used', password: 'a-strong-password' })).status, 200)
    clearSentMail()
    assert.equal((await resendWorkspaceInvite({ workspaceId, workspaceName: 'Invite Co', inviteId: row!.id, appUrl: APP_URL })).ok, false)
    const other = await inviteRow(await invite(email('resend-other')))
    clearSentMail()
    assert.equal((await resendWorkspaceInvite({ workspaceId: 'ws_other', workspaceName: 'X', inviteId: other!.id, appUrl: APP_URL })).ok, false)
    assert.equal(sentMail.length, 0)
  })
})

describe('migration', () => {
  it('adds a nullable, uniquely indexed token_hash column to invites', async () => {
    const columns = await database.execute(
      sql`select is_nullable, character_maximum_length from information_schema.columns where table_name = 'invites' and column_name = 'token_hash'`,
    )
    assert.equal(columns.rows.length, 1)
    assert.equal(columns.rows[0].is_nullable, 'YES')
    assert.equal(Number(columns.rows[0].character_maximum_length), 64)
    const indexes = await database.execute(sql`select indexdef from pg_indexes where tablename = 'invites' and indexname = 'invites_token_hash_idx'`)
    assert.equal(indexes.rows.length, 1)
    assert.match(String(indexes.rows[0].indexdef), /UNIQUE INDEX/)
  })

  it('is registered in the drizzle journal', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const dir = path.join(here, '../../../packages/db/drizzle')
    const journal = JSON.parse(fs.readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> }
    const entry = journal.entries.find((e) => e.tag.endsWith('_invite_token'))
    assert.ok(entry)
    const migration = fs.readFileSync(path.join(dir, `${entry.tag}.sql`), 'utf8')
    assert.match(migration, /ADD COLUMN "token_hash" varchar\(64\)/)
    assert.match(migration, /CREATE UNIQUE INDEX "invites_token_hash_idx"/)
  })
})

describe('release after the hook consumed the token', () => {
  it('puts the invite back when the user insert fails after the hook claimed it, and the same link then works', async () => {
    const address = email('dbfail')
    const token = await invite(address)
    let claimedInHook = false
    // A 5000-character name passes Better Auth's own checks and the
    // user.create.before hook (which consumes the token), then fails the
    // users insert (varchar(255)): a real DB error after the claim.
    await assert.rejects(() =>
      acceptInviteWithNewAccount(token, async (invited) => {
        try {
          await authApi.signUpEmail({ body: { email: invited, name: 'n'.repeat(5000), password: 'a-strong-password' } })
        } finally {
          // Observed from inside the failing attempt: the hook had consumed the invite.
          claimedInHook = Boolean((await inviteRow(token))?.acceptedAt)
        }
        return { userId: 'unreachable', result: null }
      }),
    )
    assert.equal(claimedInHook, true, 'the failure happened after the hook claimed the token')
    const row = await inviteRow(token)
    assert.equal(row?.acceptedAt, null, 'accepted_at is NULL again')
    assert.equal(await userByEmail(address), null, 'no user was created')

    const retry = await accept({ token, name: 'Retry After DB Error', password: 'a-strong-password' })
    assert.equal(retry.status, 200)
    const user = await userByEmail(address)
    assert.ok(user)
    assert.ok(await membership(user.id))
    assert.ok((await inviteRow(token))?.acceptedAt)
  })

  it('release is compare-and-set: a stale claim cannot reopen an invite that a later accept owns', async () => {
    const address = email('cas')
    const token = await invite(address)
    const stale = await claimInvite(database, token, address)
    assert.ok(stale?.acceptedAt)
    // A different, later claim now owns the invite.
    const later = new Date(stale.acceptedAt.getTime() + 5_000)
    await database.update(invites).set({ acceptedAt: later }).where(eq(invites.id, stale.id))
    await releaseInvite(database, stale)
    assert.equal((await inviteRow(token))?.acceptedAt?.getTime(), later.getTime(), 'later owner untouched')

    // The owner's own release does reopen it.
    await releaseInvite(database, { ...stale, acceptedAt: later })
    assert.equal((await inviteRow(token))?.acceptedAt, null)
  })
})

describe('expiry boundary', () => {
  it('an invite is expired at exactly its expiry instant, valid 1 ms before', async () => {
    const address = email('boundary')
    const token = await invite(address)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await database.update(invites).set({ expiresAt }).where(eq(invites.tokenHash, hashInviteToken(token)))
    const at = (ms: number) => mock.method(Date, 'now', () => ms)

    const before = at(expiresAt.getTime() - 1)
    try {
      assert.equal((await lookupInvite(token)).ok, true)
    } finally {
      before.mock.restore()
    }
    const exact = at(expiresAt.getTime())
    try {
      const result = await lookupInvite(token)
      assert.equal(result.ok, false)
      assert.equal(!result.ok && result.reason, 'expired')
    } finally {
      exact.mock.restore()
    }
  })
})

describe('races', () => {
  it('only one of many concurrent accepts by the same user wins', async () => {
    const address = email('race')
    await existingUserCookie(address)
    const user = (await userByEmail(address))!
    const token = await invite(address)
    const results = await Promise.all(Array.from({ length: 8 }, () => acceptInviteAsUser(token, user)))
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'used'))
    const rows = await database
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)))
    assert.equal(rows.length, 1)
  })

  it('only one concurrent new-account accept creates an account', async () => {
    const address = email('racenew')
    const token = await invite(address)
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => accept({ token, name: `Racer ${i}`, password: 'a-strong-password' })),
    )
    assert.equal(responses.filter((r) => r.status === 200).length, 1)
    const rows = await database.select().from(users).where(eq(users.email, address))
    assert.equal(rows.length, 1)
  })
})

describe('logging', () => {
  it('no token ever appears in logs or output', () => {
    assert.ok(tokensSeen.length > 10)
    const all = logged.join('\n')
    for (const token of tokensSeen) {
      assert.ok(!all.includes(token), 'token must not be logged')
      assert.ok(!all.includes(hashInviteToken(token)), 'token hash must not be logged')
    }
  })
})
