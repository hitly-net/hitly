/**
 * M0h M2 (PR hitly#106): cb_auth_token must never reach a reviewer.
 * Real Postgres. A canary token is ingested through the http plugin and then
 * chased through every read surface:
 *   - approvals.envelope column: must NOT contain it (strip at ingest);
 *   - approvals.origin column: DOES contain it (resume() needs it there);
 *   - getApprovalDetail (GET /api/v1/approvals/:id): must not echo it, in the
 *     `origin` projection nor in `envelope.origin`;
 *   - getOriginalRequest (GET /api/v1/approvals/:id/original-request): the
 *     canonical payload must not contain it, and the hash still matches the
 *     stored (credential-free) envelope byte-for-byte;
 *   - a legacy row whose envelope still embeds the token (written before the
 *     strip-at-ingest fix) is redacted by both readers as well.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { canonicalJson, sha256Hex } from '@hitly/core'
import { users, workspaces, memberships, projects, projectMemberships, projectApiKeys, approvals } from '@hitly/db/schema'
import { ingestApproval } from './approvals'
import { getApprovalDetail } from './approval-detail'
import { getOriginalRequest } from './original-request'
import { generateApiKey } from './keys'
import { newId } from './ids'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')
if (!DATABASE_URL) throw new Error('DATABASE_URL required for tests')

const CANARY = 'cbtok-CANARY-9f3c2a1e4b7d-do-not-echo'

let client: pg.Client
let db: ReturnType<typeof drizzle>
let workspaceA: { id: string; name: string; slug: string }
let userReviewerA: { id: string }
let projectA: { id: string }
let apiKeyARaw: string

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  // @ts-expect-error - Client vs Pool type mismatch, works at runtime
  db = drizzle(client)

  workspaceA = { id: newId('wsp'), name: 'M0h Redaction WS', slug: `m0h-ws-${Date.now()}` }
  await db.insert(workspaces).values(workspaceA)

  userReviewerA = { id: newId('usr') }
  await db.insert(users).values({
    ...userReviewerA,
    name: userReviewerA.id,
    email: `${userReviewerA.id}@m0h-test.hitly.invalid`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await db.insert(memberships).values({
    id: newId('mem'),
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    role: 'member',
    createdAt: new Date(),
  })

  projectA = { id: newId('prj') }
  await db.insert(projects).values({
    id: projectA.id,
    workspaceId: workspaceA.id,
    name: 'M0h Redaction Project',
    plugin: 'http',
    credentials: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await db.insert(projectMemberships).values({
    id: newId('pmb'),
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    role: 'user',
    createdAt: new Date(),
  })

  const keyGen = generateApiKey()
  apiKeyARaw = keyGen.raw
  await db.insert(projectApiKeys).values({
    id: newId('key'),
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    hashedKey: keyGen.hashed,
    prefix: keyGen.prefix,
    name: 'M0h Redaction Key',
    createdAt: new Date(),
  })
})

after(async () => {
  await client?.end().catch(() => undefined)
})

async function ingestWithCanary() {
  const result = await ingestApproval({
    apiKey: apiKeyARaw,
    body: {
      resumeUrl: 'http://127.0.0.1:19991/resume',
      runId: newId('run'),
      workflowName: 'm0h-redaction',
      actionName: 'm0h-refund',
      args: { amount: 42 },
      cb_auth_token: CANARY,
      metadata: { pageId: 'p1' },
    },
  })
  assert.ok(result.ok, `ingest should succeed: ${result.ok ? '' : result.error}`)
  return result.approval
}

async function storedRow(approvalId: string) {
  const rows = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  assert.ok(rows[0], 'approval row exists')
  return rows[0]
}

test('token is stored only on the origin column; the stored envelope is credential-free', async () => {
  const approval = await ingestWithCanary()
  const row = await storedRow(approval.id)

  const originText = JSON.stringify(row.origin)
  assert.ok(originText.includes(CANARY), 'origin.resumeHandle must keep the token for resume()')

  const envelopeText = JSON.stringify(row.envelope)
  assert.ok(!envelopeText.includes(CANARY), 'the create-once envelope column must never carry the token')
  const embedded = (row.envelope as Record<string, unknown>).origin as
    | { resumeHandle?: Record<string, unknown> }
    | undefined
  assert.ok(embedded?.resumeHandle, 'envelope still embeds origin for display fallback')
  assert.equal(embedded.resumeHandle!.cbAuthToken, undefined, 'embedded origin copy must be stripped at ingest')
})

test('GET /approvals/:id (getApprovalDetail) never echoes the token to reviewers', async () => {
  const approval = await ingestWithCanary()
  const detail = await getApprovalDetail({
    approvalId: approval.id,
    userId: userReviewerA.id,
    workspaceId: workspaceA.id,
    workspaceRole: 'member',
  })
  assert.ok(detail.ok, 'detail should be readable')
  const shown = JSON.stringify(detail)
  assert.ok(!shown.includes(CANARY), 'the full detail projection must not contain the token')
  assert.equal((detail.origin as { resumeHandle?: Record<string, unknown> }).resumeHandle?.cbAuthToken, undefined)
  const embedded = (detail.envelope as Record<string, unknown>).origin as
    | { resumeHandle?: Record<string, unknown> }
    | undefined
  assert.equal(embedded?.resumeHandle?.cbAuthToken, undefined)
  // Non-secret origin data still comes through (this is not a blanket origin strip).
  assert.equal((detail.origin as { resumeHandle?: Record<string, unknown> }).resumeHandle?.resumeUrl, 'http://127.0.0.1:19991/resume')
  assert.ok(detail.originFields.some((field) => field.key === 'workflowName'))
})

test('GET /approvals/:id/original-request never echoes the token and keeps byte-exact hashes', async () => {
  const approval = await ingestWithCanary()
  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`)
  assert.ok(!result.canonicalPayload.includes(CANARY), 'canonical payload must not contain the token')

  // Read-side strip must be a no-op for clean rows: the copy and its hash stay
  // byte-identical to the stored envelope, so verifier checks keep working.
  const row = await storedRow(approval.id)
  const storedCanonical = canonicalJson(row.envelope)
  assert.equal(result.canonicalPayload, storedCanonical)
  assert.equal(result.payloadSha256, await sha256Hex(storedCanonical))
})

test('legacy rows with the token embedded in the envelope are redacted by both readers', async () => {
  // Simulate a row written before strip-at-ingest existed: the create-once
  // envelope embeds origin WITH the credential.
  const approvalId = newId('apr').slice(0, 36)
  const origin = {
    plugin: 'http',
    projectId: projectA.id,
    runId: 'run_legacy',
    resumeHandle: { resumeUrl: 'http://127.0.0.1:19991/resume', cbAuthToken: CANARY, metadata: { pageId: 'p9' } },
  }
  const envelope = {
    action: { name: 'm0h-refund', args: { amount: 7 } },
    allowedActions: { accept: true, reject: true },
    origin,
  }
  await db.insert(approvals).values({
    id: approvalId,
    workspaceId: workspaceA.id,
    projectId: projectA.id,
    plugin: 'http',
    status: 'pending',
    actionName: 'm0h-refund',
    envelope: envelope as unknown as Record<string, unknown>,
    origin: origin as unknown as Record<string, unknown>,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  // The fixture itself must contain the canary, else the test proves nothing.
  assert.ok(JSON.stringify((await storedRow(approvalId)).envelope).includes(CANARY))

  const detail = await getApprovalDetail({
    approvalId,
    userId: userReviewerA.id,
    workspaceId: workspaceA.id,
    workspaceRole: 'member',
  })
  assert.ok(detail.ok)
  assert.ok(!JSON.stringify(detail).includes(CANARY), 'detail must redact a dirty embedded origin')

  const original = await getOriginalRequest({
    approvalId,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(original.ok)
  assert.ok(!original.canonicalPayload.includes(CANARY), 'original-request must redact a dirty stored envelope')
})
