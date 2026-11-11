/**
 * Branded decision-needed notification against real Postgres, under an
 * ENCRYPTED edition (edition.encryptDocument/decryptDocument active).
 *
 * Proves M2 + push-title rules end-to-end:
 *  - envelope/origin are stored encrypted and decoded with decodeTenantJson
 *    before rendering, so the email still carries the question and "asked
 *    by" (a missed decode would render without them);
 *  - the push copy reuses the same wording helper: ask_user title = the
 *    question, request_approval title = the action summary; body carries the
 *    real expiry;
 *  - planted secrets (callback tokens, resume handles, arg secrets) never
 *    reach the email or the push payload, and raw tool names never appear.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { edition } from '@hitly/cloud'
import { clearSentMail, sentMail } from '@hitly/mail'
import {
  approvals,
  memberships,
  projectApiKeys,
  projectChannels,
  projects,
  pushTokens,
  users,
  workspaces,
} from '@hitly/db/schema'
import { notifyAssignee, notifyPendingItemPush } from './notify'
import type { ExpoPushSendResult } from './push'
import { encodeTenantJson } from './tenant-crypto'
import { newId } from './ids'
import { withTenant } from './tenant'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:***@localhost:5432/hitly'

// --- Fake encrypted edition -------------------------------------------------
// A reversible transform (not real crypto — we are testing that the host
// READS THROUGH the edition hooks, not the cipher itself). Anything stored
// while these are installed is unreadable as plaintext, so the assertions
// below can only pass if the decision copy path decodes first.
const ENC_MARKER = '__testEnc'
function fakeEncrypt(value: unknown): Record<string, unknown> {
  return { [ENC_MARKER]: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') }
}
function fakeDecrypt(value: unknown): unknown {
  if (value && typeof value === 'object' && ENC_MARKER in (value as Record<string, unknown>)) {
    const packed = String((value as Record<string, unknown>)[ENC_MARKER])
    return JSON.parse(Buffer.from(packed, 'base64').toString('utf8'))
  }
  return value
}

// --- Fixtures ----------------------------------------------------------------
let client: pg.Client
let database: ReturnType<typeof drizzle>

let workspaceId: string
let projectId: string
let assigneeId: string // email recipient, no push device
let adminId: string // push recipient
let requesterKeyId: string
let askApprovalId: string
let approvalApprovalId: string
let expiresAt: Date

const QUESTION = 'Which restaurant should I book for Saturday?'
const ACTION_SUMMARY = 'Refund order 4410 above the manual limit'
const CANARIES = [
  'CANARY-CB-TOKEN',
  'CANARY-RESUME-HANDLE',
  'CANARY-ARG-SECRET',
  'CANARY-ORIGIN-SECRET',
] as const

async function cleanupPreviousRuns() {
  // Stability runs reuse the database; wipe any fixtures from earlier runs.
  const staleWorkspaces = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(sql`${workspaces.slug} LIKE ${'notify-test%'}`)
  for (const row of staleWorkspaces) {
    await database.delete(workspaces).where(eq(workspaces.id, row.id)) // cascades to fixtures
  }
  await database.delete(users).where(sql`${users.email} IN ('notify-reviewer@example.invalid', 'notify-admin@example.invalid')`)
}

async function seed() {
  await cleanupPreviousRuns()
  workspaceId = newId('wsp')
  projectId = newId('prj')
  assigneeId = newId('usr')
  adminId = newId('usr')
  requesterKeyId = newId('key')
  askApprovalId = newId('apr')
  approvalApprovalId = newId('apr')
  expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

  await database.insert(workspaces).values({ id: workspaceId, name: 'Notify Test', slug: `notify-test-${Date.now().toString(36)}` })
  await database.insert(users).values([
    { id: assigneeId, email: 'notify-reviewer@example.invalid', name: 'Derek Colley', emailVerified: true },
    { id: adminId, email: 'notify-admin@example.invalid', name: 'Workspace Admin', emailVerified: true },
  ])
  await database.insert(memberships).values([
    { id: newId('mem'), workspaceId, userId: adminId, role: 'admin' as const },
    { id: newId('mem'), workspaceId, userId: assigneeId, role: 'member' as const },
  ])
  await database.insert(projects).values({
    id: projectId,
    workspaceId,
    name: 'Restaurant week',
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
  await database.insert(projectApiKeys).values({
    id: requesterKeyId,
    workspaceId,
    projectId,
    name: 'Weekend planner key',
    hashedKey: 'notify-test-hash',
    prefix: 'notify-test',
  })
  await database.insert(pushTokens).values({
    id: newId('dev'),
    userId: adminId,
    token: 'ExponentPushToken[notify-decision-test]',
    platform: 'ios',
  })

  // Envelope/origin written THROUGH the encrypted edition (encodeTenantJson).
  const askEnvelope = {
    action: { name: 'ask_user', args: { topic: 'dinner', apiKey: 'CANARY-ARG-SECRET' } },
    allowedActions: { accept: true, reject: true },
    prompt: QUESTION,
    metadata: { cb_auth_token: 'CANARY-CB-TOKEN' },
    expiresAt: expiresAt.toISOString(),
  }
  const askOrigin = {
    plugin: 'mastra',
    agentName: 'Weekend planner',
    resumeHandle: { url: 'https://agent.invalid/cb', secret: 'CANARY-RESUME-HANDLE' },
    runId: 'run-1',
    apiKeySecret: 'CANARY-ORIGIN-SECRET',
  }
  const approvalEnvelope = {
    action: { name: 'request_approval', args: { order: 4410, token: 'CANARY-ARG-SECRET' } },
    allowedActions: { accept: true, reject: true },
    metadata: { summary: ACTION_SUMMARY, cb_auth_token: 'CANARY-CB-TOKEN' },
    expiresAt: expiresAt.toISOString(),
  }
  const approvalOrigin = {
    plugin: 'mastra',
    agentName: 'Support agent',
    resumeHandle: { url: 'https://agent.invalid/cb', secret: 'CANARY-RESUME-HANDLE' },
    runId: 'run-2',
  }

  await database.insert(approvals).values([
    {
      id: askApprovalId,
      workspaceId,
      projectId,
      assignedUserId: assigneeId,
      plugin: 'mastra',
      status: 'pending',
      actionName: 'ask_user',
      envelope: await encodeTenantJson(workspaceId, askEnvelope),
      origin: await encodeTenantJson(workspaceId, askOrigin),
      requesterKeyId,
      expiresAt,
    },
    {
      id: approvalApprovalId,
      workspaceId,
      projectId,
      assignedUserId: assigneeId,
      plugin: 'mastra',
      status: 'pending',
      actionName: 'request_approval',
      envelope: await encodeTenantJson(workspaceId, approvalEnvelope),
      origin: await encodeTenantJson(workspaceId, approvalOrigin),
      requesterKeyId,
      expiresAt,
    },
  ])
}

before(async () => {
  edition.encryptDocument = async (_workspaceId: string, value) => fakeEncrypt(value) as never
  edition.decryptDocument = async (_workspaceId: string, value) => fakeDecrypt(value) as never
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  database = drizzle(client) as unknown as typeof database
  await seed()
})

after(async () => {
  delete (edition as { encryptDocument?: unknown }).encryptDocument
  delete (edition as { decryptDocument?: unknown }).decryptDocument
  await client?.end()
})

test('encrypted edition: stored envelope/origin are ciphertext, not plaintext', async () => {
  const rows = await database
    .select({ envelope: approvals.envelope, origin: approvals.origin })
    .from(approvals)
  const stored = rows.map((row) => JSON.stringify(row)).join('\n')
  assert.ok(stored.includes(ENC_MARKER), 'envelopes must be stored through the edition cipher')
  for (const needle of [QUESTION, ACTION_SUMMARY, ...CANARIES]) {
    assert.ok(!stored.includes(needle), `stored rows must not contain ${needle}`)
  }
})

test('encrypted edition: decision email decodes envelope/origin and keeps secrets out', async () => {
  clearSentMail()
  // Inject the push sender so the detached afterTenantCommit push never
  // touches the real Expo endpoint from a test.
  const capturePush = async (payload: {
    tokens: string[]
    title: string
    body: string
  }): Promise<ExpoPushSendResult> => ({
    tickets: payload.tokens.map((token) => ({ token, delivered: true })),
    staleTokens: [],
  })
  await withTenant(workspaceId, () =>
    notifyAssignee({
      workspaceId,
      projectId,
      approvalId: askApprovalId,
      assignedUserId: assigneeId,
      channelTypes: ['email'],
      expiresAt,
      sendPush: capturePush,
    }),
  )
  assert.equal(sentMail.length, 1, 'one branded email delivered')
  const mail = sentMail[0]!
  assert.equal(mail.to, 'notify-reviewer@example.invalid')
  const html = mail.html ?? ''
  const flat = `${mail.subject}\n${mail.text}\n${html}`
  // Decoded content actually rendered (would be missing if read undecoded):
  assert.ok(mail.subject.includes(QUESTION), 'subject carries the decoded question')
  assert.ok(mail.text.includes(QUESTION), 'text body carries the question')
  assert.ok(html.includes(QUESTION), 'html carries the question')
  assert.ok(mail.text.includes('Asked by: Weekend planner'), 'asked-by decoded from origin')
  assert.ok(mail.text.includes('Project: Restaurant week'), 'project name present')
  assert.ok(mail.text.includes('Deadline:'), 'readable deadline present')
  assert.ok(html.includes('Open in HITLy'), 'branded button present')
  // Redaction: no secrets, no raw tool names, no cipher leftovers.
  for (const canary of CANARIES) {
    assert.ok(!flat.includes(canary), `email must not contain ${canary}`)
  }
  for (const tool of ['ask_user', 'request_approval', 'cb_auth_token', ENC_MARKER]) {
    assert.ok(!flat.includes(tool), `email must not contain ${tool}`)
  }
})

test('encrypted edition: ask_user push title is the decoded question with real-expiry body', async () => {
  const sent: Array<{ title: string; body: string; tokens: string[] }> = []
  const sendPush = async (payload: {
    tokens: string[]
    title: string
    body: string
  }): Promise<ExpoPushSendResult> => {
    sent.push(payload)
    return { tickets: payload.tokens.map((token) => ({ token, delivered: true })), staleTokens: [] }
  }
  await notifyPendingItemPush({
    workspaceId,
    projectId,
    approvalId: askApprovalId,
    assignedUserId: assigneeId,
    expiresAt,
    sendPush,
  })
  assert.equal(sent.length, 1, 'push delivered to the admin device')
  assert.deepEqual(sent[0]!.tokens, ['ExponentPushToken[notify-decision-test]'])
  assert.equal(sent[0]!.title, QUESTION, 'ask_user title = decoded question')
  assert.match(sent[0]!.body, /^Restaurant week · expires in \d+m?h$/)
  const flat = `${sent[0]!.title}\n${sent[0]!.body}`
  for (const canary of [...CANARIES, 'ask_user', ENC_MARKER]) {
    assert.ok(!flat.includes(canary), `push must not contain ${canary}`)
  }
})

test('encrypted edition: request_approval push title is the action summary', async () => {
  const sent: Array<{ title: string; body: string }> = []
  const sendPush = async (payload: {
    tokens: string[]
    title: string
    body: string
  }): Promise<ExpoPushSendResult> => {
    sent.push(payload)
    return { tickets: payload.tokens.map((token) => ({ token, delivered: true })), staleTokens: [] }
  }
  await notifyPendingItemPush({
    workspaceId,
    projectId,
    approvalId: approvalApprovalId,
    assignedUserId: assigneeId,
    expiresAt,
    sendPush,
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.title, `HITLy: ${ACTION_SUMMARY}`, 'approval title = action summary')
  assert.ok(!sent[0]!.title.includes('request_approval'))
  const flat = `${sent[0]!.title}\n${sent[0]!.body}`
  for (const canary of [...CANARIES, 'request_approval', ENC_MARKER]) {
    assert.ok(!flat.includes(canary), `push must not contain ${canary}`)
  }
})
