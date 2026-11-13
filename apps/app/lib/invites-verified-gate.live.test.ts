/**
 * Unverified-email gate on workspace invite sends and resends (S3), against
 * real Postgres. With the flag ON an unverified acting account cannot send
 * or resend invites: no invite row is written, an existing invite keeps its
 * token and expiry, and no email goes out. Verified actors are unaffected,
 * and with the flag OFF (closed beta) behaviour is unchanged.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { and, eq, isNull } from 'drizzle-orm'
import { invites, memberships, users, workspaces } from '@hitly/db/schema'
import { clearSentMail, sentMail, type sendMail } from '@hitly/mail'
import { db } from './db'
import { newId } from './ids'
import { addExistingUserToWorkspace, createAndSendWorkspaceInvite, resendWorkspaceInvite } from './invites'
import { VerifiedEmailRequiredError } from './verified-gate'

if (!db) throw new Error('DATABASE_URL required for tests')
const database = db

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const run = newId('t').slice(-10)
const workspaceId = newId('ws').slice(0, 36)
const verifiedActorId = newId('usr').slice(0, 36)
const unverifiedActorId = newId('usr').slice(0, 36)

/** Fake transport that counts sends and satisfies the sendMail signature. */
function captureSend(): { readonly calls: () => number; send: typeof sendMail } {
  let n = 0
  return {
    calls: () => n,
    send: async () => {
      n += 1
      return { delivered: true as const }
    },
  }
}

function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  if (value === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = value
  return fn().finally(() => {
    if (saved === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
    else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = saved
  })
}

async function seedUser(id: string, emailVerified: boolean) {
  await database.insert(users).values({
    id,
    email: `gate-${id.slice(-8)}@${run}.example.com`,
    name: emailVerified ? 'Verified Actor' : 'Unverified Actor',
    emailVerified,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

async function pendingInviteRow(email: string) {
  const rows = await database
    .select()
    .from(invites)
    .where(and(eq(invites.workspaceId, workspaceId), eq(invites.email, email), isNull(invites.acceptedAt)))
    .limit(1)
  return rows[0] ?? null
}

before(async () => {
  await database.insert(workspaces).values({ id: workspaceId, name: 'Gate Co', slug: `gate-co-${run}` })
  await seedUser(verifiedActorId, true)
  await seedUser(unverifiedActorId, false)
  await database.insert(memberships).values({ id: newId('mem').slice(0, 36), workspaceId, userId: verifiedActorId, role: 'owner' })
})

after(async () => {
  await database.delete(invites).where(eq(invites.workspaceId, workspaceId))
  await database.delete(memberships).where(eq(memberships.workspaceId, workspaceId))
  await database.delete(users).where(eq(users.id, verifiedActorId))
  await database.delete(users).where(eq(users.id, unverifiedActorId))
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId))
})

describe('unverified-email gate on workspace invites (live)', () => {
  it('flag ON: unverified actor cannot send an invite — no row written, no email sent', async () => {
    await withFlag('1', async () => {
      clearSentMail()
      const send = captureSend()
      const email = `blocked-${run}@example.com`
      await assert.rejects(
        () =>
          createAndSendWorkspaceInvite({
            workspaceId,
            workspaceName: 'Gate Co',
            email,
            role: 'member',
            invitedByUserId: unverifiedActorId,
            actorUserId: unverifiedActorId,
            appUrl: APP_URL,
            database,
            send: send.send,
          }),
        (error: unknown) =>
          error instanceof VerifiedEmailRequiredError && error.code === 'email_not_verified',
      )
      assert.equal(await pendingInviteRow(email), null, 'refused invite writes no row')
      assert.equal(send.calls(), 0, 'refused invite sends no email')
      assert.equal(sentMail.filter((mail) => mail.to === email).length, 0, 'nothing leaked to the memory transport either')
    })
  })

  it('flag ON: unverified actor cannot resend an invite — token and expiry untouched, no email sent', async () => {
    await withFlag('1', async () => {
      const email = `resend-${run}@example.com`
      const created = await createAndSendWorkspaceInvite({
        workspaceId,
        workspaceName: 'Gate Co',
        email,
        role: 'member',
        invitedByUserId: verifiedActorId,
        actorUserId: verifiedActorId,
        appUrl: APP_URL,
        database,
        send: captureSend().send,
      })
      const beforeRow = await pendingInviteRow(email)
      assert.ok(beforeRow, 'invite exists for the resend attempt')
      const send = captureSend()
      await assert.rejects(
        () =>
          resendWorkspaceInvite({
            workspaceId,
            workspaceName: 'Gate Co',
            inviteId: created.id,
            actorUserId: unverifiedActorId,
            appUrl: APP_URL,
            database,
            send: send.send,
          }),
        (error: unknown) =>
          error instanceof VerifiedEmailRequiredError && error.code === 'email_not_verified',
      )
      const afterRow = await pendingInviteRow(email)
      assert.equal(afterRow!.tokenHash, beforeRow!.tokenHash, 'existing token untouched by the refusal')
      assert.equal(afterRow!.expiresAt.getTime(), beforeRow!.expiresAt.getTime(), 'existing expiry untouched')
      assert.equal(send.calls(), 0, 'refused resend sends no email')
    })
  })

  it('flag ON: a verified actor sends and resends unaffected', async () => {
    await withFlag('1', async () => {
      const email = `verified-${run}@example.com`
      const send = captureSend()
      const created = await createAndSendWorkspaceInvite({
        workspaceId,
        workspaceName: 'Gate Co',
        email,
        role: 'member',
        invitedByUserId: verifiedActorId,
        actorUserId: verifiedActorId,
        appUrl: APP_URL,
        database,
        send: send.send,
      })
      assert.ok(created.id, 'invite written for the verified actor')
      const row = await pendingInviteRow(email)
      assert.ok(row, 'invite row present')
      const resent = await resendWorkspaceInvite({
        workspaceId,
        workspaceName: 'Gate Co',
        inviteId: created.id,
        actorUserId: verifiedActorId,
        appUrl: APP_URL,
        database,
        send: send.send,
      })
      assert.equal(resent.ok, true)
      assert.equal(send.calls(), 2, 'both the send and the resend emailed')
    })
  })

  it('flag OFF (closed beta): an unverified actor sends and resends exactly as before', async () => {
    await withFlag(undefined, async () => {
      const email = `flagoff-${run}@example.com`
      const send = captureSend()
      const created = await createAndSendWorkspaceInvite({
        workspaceId,
        workspaceName: 'Gate Co',
        email,
        role: 'member',
        invitedByUserId: unverifiedActorId,
        actorUserId: unverifiedActorId,
        appUrl: APP_URL,
        database,
        send: send.send,
      })
      assert.ok(created.id)
      const row = await pendingInviteRow(email)
      assert.ok(row, 'invite written while the flag is off')
      const resent = await resendWorkspaceInvite({
        workspaceId,
        workspaceName: 'Gate Co',
        inviteId: created.id,
        actorUserId: unverifiedActorId,
        appUrl: APP_URL,
        database,
        send: send.send,
      })
      assert.equal(resent.ok, true)
      assert.equal(send.calls(), 2)
    })
  })

  it('flag ON: verifying the actor immediately unblocks invites (current stored flag)', async () => {
    await withFlag('1', async () => {
      await database
        .update(users)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, unverifiedActorId))
      const email = `afterverify-${run}@example.com`
      const send = captureSend()
      const created = await createAndSendWorkspaceInvite({
        workspaceId,
        workspaceName: 'Gate Co',
        email,
        role: 'member',
        invitedByUserId: unverifiedActorId,
        actorUserId: unverifiedActorId,
        appUrl: APP_URL,
        database,
        send: send.send,
      })
      assert.ok(created.id, 'invite succeeds once the stored flag is verified')
      assert.equal(send.calls(), 1)
    })
  })
})

describe('unverified-email gate on adding an EXISTING account (live, S10)', () => {
  const addedUserId = newId('usr').slice(0, 36)
  const addedEmail = `gate-${addedUserId.slice(-8)}@${run}.example.com`

  before(async () => {
    // The invite suite above has a test that verifies the unverified actor
    // (verifying-unblocks check); restore the unverified state for this
    // suite's actor.
    await database
      .update(users)
      .set({ emailVerified: false, updatedAt: new Date() })
      .where(eq(users.id, unverifiedActorId))
    await database.insert(users).values({
      id: addedUserId,
      email: addedEmail,
      name: 'Existing Account',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  after(async () => {
    await database.delete(memberships).where(eq(memberships.userId, addedUserId))
    await database.delete(users).where(eq(users.id, addedUserId))
  })

  async function membershipCount() {
    const rows = await database
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, addedUserId)))
    return rows.length
  }

  function addAs(actorId: string, role: 'admin' | 'member' = 'member', send = captureSend()) {
    return {
      promise: addExistingUserToWorkspace({
        workspaceId,
        workspaceName: 'Gate Co',
        userId: addedUserId,
        email: addedEmail,
        role,
        actorUserId: actorId,
        appUrl: APP_URL,
        database,
        send: send.send,
      }),
      send,
    }
  }

  it('flag ON: unverified actor cannot add an existing account — no membership row, no mail', async () => {
    await withFlag('1', async () => {
      const send = captureSend()
      await assert.rejects(() => addAs(unverifiedActorId, 'member', send).promise, VerifiedEmailRequiredError)
      assert.equal(await membershipCount(), 0, 'no membership row written')
      assert.equal(send.calls(), 0, 'no "added to workspace" mail sent')
    })
  })

  it('flag ON: refused for the admin role too', async () => {
    await withFlag('1', async () => {
      const send = captureSend()
      await assert.rejects(() => addAs(unverifiedActorId, 'admin', send).promise, VerifiedEmailRequiredError)
      assert.equal(await membershipCount(), 0)
      assert.equal(send.calls(), 0)
    })
  })

  it('flag ON: a verified actor adds the existing account and the mail goes out', async () => {
    await withFlag('1', async () => {
      const send = captureSend()
      await addAs(verifiedActorId, 'member', send).promise
      assert.equal(await membershipCount(), 1)
      assert.equal(send.calls(), 1)
      await database.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, addedUserId)))
    })
  })

  it('flag OFF (closed beta): an unverified actor adds exactly as before', async () => {
    await withFlag(undefined, async () => {
      const send = captureSend()
      await addAs(unverifiedActorId, 'member', send).promise
      assert.equal(await membershipCount(), 1)
      assert.equal(send.calls(), 1)
      await database.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, addedUserId)))
    })
  })
})
