/**
 * Unverified-email gate on notification dispatch, against real Postgres.
 *
 * Proves the ruling end-to-end (HITLY_REQUIRE_VERIFIED_EMAIL):
 *  - flag OFF (closed beta): unverified recipients get the decision email
 *    and push exactly as before;
 *  - flag ON: unverified assignees get NO decision email, unverified
 *    reviewers/admins get NO push, verified users are unaffected;
 *  - flipping the stored flag to verified immediately re-enables delivery;
 *  - the verification email itself (signed-in resend) still sends while the
 *    flag is on — account-security mail is never gated.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { clearSentMail, sentMail } from '@hitly/mail'
import {
  approvals,
  memberships,
  pendingEmailVerifications,
  projectChannels,
  projectMemberships,
  projects,
  pushTokens,
  users,
  workspaces,
} from '@hitly/db/schema'
import { handleResendEmailVerification } from './email-verification-route'
import { notifyAssignee, notifyPendingItemPush } from './notify'
import type { ExpoPushSendResult } from './push'
import { newId } from './ids'
import { withTenant } from './tenant'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:***@localhost:5432/hitly'
const SLUG_PREFIX = 'verifygate-test'

let client: pg.Client
type ResendDeps = NonNullable<Parameters<typeof handleResendEmailVerification>[1]>
type SchemaDatabase = NonNullable<ResendDeps['database']>
let database: SchemaDatabase

let workspaceId: string
let projectId: string
let approvalId: string
let verifiedAssigneeId: string
let unverifiedAssigneeId: string
let verifiedReviewerId: string
let unverifiedReviewerId: string

const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

async function cleanupPreviousRuns() {
  const staleWorkspaces = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(sql`${workspaces.slug} LIKE ${SLUG_PREFIX + '%'}`)
  for (const row of staleWorkspaces) {
    await database.delete(workspaces).where(eq(workspaces.id, row.id)) // cascades to fixtures
  }
  await database.delete(users).where(sql`${users.email} LIKE ${'%@verifygate.example.invalid'}`)
}

async function seed() {
  await cleanupPreviousRuns()
  workspaceId = newId('wsp')
  projectId = newId('prj')
  approvalId = newId('apr')
  verifiedAssigneeId = newId('usr')
  unverifiedAssigneeId = newId('usr')
  verifiedReviewerId = newId('usr')
  unverifiedReviewerId = newId('usr')

  await database.insert(workspaces).values({
    id: workspaceId,
    name: 'VerifyGate Test',
    slug: `${SLUG_PREFIX}-${Date.now().toString(36)}`,
  })
  await database.insert(users).values([
    { id: verifiedAssigneeId, email: 'verified-assignee@verifygate.example.invalid', name: 'Verified Assignee', emailVerified: true },
    { id: unverifiedAssigneeId, email: 'unverified-assignee@verifygate.example.invalid', name: 'Unverified Assignee', emailVerified: false },
    { id: verifiedReviewerId, email: 'verified-reviewer@verifygate.example.invalid', name: 'Verified Reviewer', emailVerified: true },
    { id: unverifiedReviewerId, email: 'unverified-reviewer@verifygate.example.invalid', name: 'Unverified Reviewer', emailVerified: false },
  ])
  await database.insert(memberships).values([
    { id: newId('mem'), workspaceId, userId: verifiedAssigneeId, role: 'admin' as const },
    { id: newId('mem'), workspaceId, userId: unverifiedAssigneeId, role: 'member' as const },
    { id: newId('mem'), workspaceId, userId: verifiedReviewerId, role: 'member' as const },
    { id: newId('mem'), workspaceId, userId: unverifiedReviewerId, role: 'member' as const },
  ])
  await database.insert(projects).values({
    id: projectId,
    workspaceId,
    name: 'Gate project',
    plugin: 'mastra',
    credentials: {},
  })
  await database.insert(projectChannels).values({
    id: newId('ch'),
    workspaceId,
    projectId,
    type: 'email',
    config: {},
    enabled: true,
  })
  await database.insert(projectMemberships).values([
    { id: newId('pm'), workspaceId, projectId, userId: verifiedReviewerId, role: 'user' as const },
    { id: newId('pm'), workspaceId, projectId, userId: unverifiedReviewerId, role: 'user' as const },
  ])
  // One push device for each reviewer so the push gate is observable.
  await database.insert(pushTokens).values([
    { id: newId('dev'), userId: verifiedReviewerId, token: 'ExponentPushToken[verifygate-verified]', platform: 'ios' },
    { id: newId('dev'), userId: unverifiedReviewerId, token: 'ExponentPushToken[verifygate-unverified]', platform: 'android' },
  ])
  await database.insert(approvals).values({
    id: approvalId,
    workspaceId,
    projectId,
    assignedUserId: unverifiedAssigneeId,
    plugin: 'mastra',
    status: 'pending',
    actionName: 'ask_user',
    envelope: { prompt: 'Gate: pick a window?', expiresAt: expiresAt.toISOString() },
    origin: { plugin: 'mastra', agentName: 'Gate agent' },
    expiresAt,
  })
}

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  database = drizzle(client) as unknown as SchemaDatabase
  await seed()
})

after(async () => {
  await database.delete(pendingEmailVerifications).where(sql`${pendingEmailVerifications.email} LIKE ${'%@verifygate.example.invalid'}`)
  await cleanupPreviousRuns()
  await client?.end()
})

function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  if (value === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = value
  return fn().finally(() => {
    if (saved === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
    else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = saved
  })
}

function capturePushSender(sent: Array<{ tokens: string[] }>) {
  return async (payload: { tokens: string[]; title: string; body: string }): Promise<ExpoPushSendResult> => {
    sent.push(payload)
    return { tickets: payload.tokens.map((token) => ({ token, delivered: true })), staleTokens: [] }
  }
}

async function runAssigneeNotify(assignedUserId: string, sent: Array<{ tokens: string[] }>) {
  await withTenant(workspaceId, () =>
    notifyAssignee({
      workspaceId,
      projectId,
      approvalId,
      assignedUserId,
      channelTypes: ['email'],
      expiresAt,
      sendPush: capturePushSender(sent),
    }),
  )
}

test('flag OFF: unverified assignee still gets the email and push (current behaviour)', async () => {
  await withFlag(undefined, async () => {
    clearSentMail()
    const sent: Array<{ tokens: string[] }> = []
    await runAssigneeNotify(unverifiedAssigneeId, sent)
    assert.equal(sentMail.filter((m) => m.to === 'unverified-assignee@verifygate.example.invalid').length, 1)
    // Push is asserted through the direct call (the notifyAssignee push is
    // detached on afterTenantCommit; the sender above just keeps it off the
    // real Expo endpoint), mirroring notify-decision-email.test.ts.
    await notifyPendingItemPush({
      workspaceId,
      projectId,
      approvalId,
      assignedUserId: unverifiedAssigneeId,
      expiresAt,
      sendPush: capturePushSender(sent),
    })
    const tokens = sent.flatMap((p) => p.tokens)
    assert.ok(tokens.includes('ExponentPushToken[verifygate-unverified]'), 'unverified reviewer pushed')
    assert.ok(tokens.includes('ExponentPushToken[verifygate-verified]'), 'verified reviewer pushed')
  })
})

test('flag ON: unverified assignee gets no email', async () => {
  await withFlag('1', async () => {
    clearSentMail()
    const sent: Array<{ tokens: string[] }> = []
    await runAssigneeNotify(unverifiedAssigneeId, sent)
    assert.equal(sentMail.filter((m) => m.to === 'unverified-assignee@verifygate.example.invalid').length, 0)
  })
})

test('flag ON: unverified reviewers get no push, verified reviewers do', async () => {
  await withFlag('1', async () => {
    const sent: Array<{ tokens: string[] }> = []
    await notifyPendingItemPush({
      workspaceId,
      projectId,
      approvalId,
      assignedUserId: unverifiedAssigneeId,
      expiresAt,
      sendPush: capturePushSender(sent),
    })
    const tokens = sent.flatMap((p) => p.tokens)
    assert.ok(!tokens.includes('ExponentPushToken[verifygate-unverified]'), 'unverified reviewer NOT pushed')
    assert.ok(tokens.includes('ExponentPushToken[verifygate-verified]'), 'verified reviewer pushed')
  })
})

test('flag ON: verified assignee unaffected', async () => {
  await withFlag('1', async () => {
    clearSentMail()
    const sent: Array<{ tokens: string[] }> = []
    await runAssigneeNotify(verifiedAssigneeId, sent)
    assert.equal(sentMail.filter((m) => m.to === 'verified-assignee@verifygate.example.invalid').length, 1)
    await notifyPendingItemPush({
      workspaceId,
      projectId,
      approvalId,
      assignedUserId: verifiedAssigneeId,
      expiresAt,
      sendPush: capturePushSender(sent),
    })
    assert.ok(sent.flatMap((p) => p.tokens).includes('ExponentPushToken[verifygate-verified]'))
  })
})

test('flag ON: verifying the stored flag immediately re-enables delivery', async () => {
  await withFlag('1', async () => {
    await database
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, unverifiedAssigneeId))
    clearSentMail()
    const sent: Array<{ tokens: string[] }> = []
    await runAssigneeNotify(unverifiedAssigneeId, sent)
    assert.equal(sentMail.filter((m) => m.to === 'unverified-assignee@verifygate.example.invalid').length, 1)
    await database
      .update(users)
      .set({ emailVerified: false, updatedAt: new Date() })
      .where(eq(users.id, unverifiedAssigneeId))
  })
})

test('flag ON: the verification email itself still sends (security mail is never gated)', async () => {
  await withFlag('1', async () => {
    const mailed: Array<{ to: string; token: string }> = []
    const response = await handleResendEmailVerification(
      { headers: new Headers(), json: async () => ({}) },
      {
        database,
        getSessionUser: async () => ({ id: unverifiedAssigneeId }),
        clientKey: () => 'verifygate-test-client',
        allow: () => true,
        log: () => {},
        send: async (args) => {
          mailed.push(args)
        },
      },
    )
    assert.equal(response.status, 200)
    assert.equal(mailed.length, 1, 'verification mail queued while the gate is on')
    assert.equal(mailed[0]!.to, 'unverified-assignee@verifygate.example.invalid')
  })
})
