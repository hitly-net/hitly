/**
 * M0h M5 (+ M1 at the DB level), PR hitly#106: event-id dedupe across host retries.
 * Real Postgres + a real localhost receiver.
 *
 * A decide whose receiver keeps answering 500 must land in failed_resume with
 * three POSTs all carrying ONE event id (in-process dedupe), a stored
 * ResumeResponse without the receiver body, and no canary anywhere a reviewer
 * can read. Then retryResume (the ~24 h tail) must re-send the SAME event id,
 * so a receiver that processed a 5xx'd delivery can dedupe on it
 * (spec (e): "event_id-deduped"). A different approval gets a different id.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import * as http from 'node:http'
import { test, before, after } from 'node:test'
import { AddressInfo } from 'node:net'
import { drizzle } from 'drizzle-orm/node-postgres'
import { desc, eq, and } from 'drizzle-orm'
import pg from 'pg'
import { users, workspaces, memberships, projects, projectMemberships, projectApiKeys, decisionRecords } from '@hitly/db/schema'
import { ingestApproval, decideApproval, retryResume } from './approvals'
import { getApprovalDetail } from './approval-detail'
import { generateApiKey } from './keys'
import { newId } from './ids'

const DATABASE_URL = process.env.DATABASE_URL ?? ''
if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')
if (!DATABASE_URL) throw new Error('DATABASE_URL required for tests')

const RECEIVER_BODY_CANARY = 'canary-m0h-5xx-page-body'
const RECEIVER_PORT = 19990

interface ReceiverHit {
  body: Record<string, unknown>
  eventIdHeader: string | null
}

let client: pg.Client
let db: ReturnType<typeof drizzle>
let receiver: http.Server | null = null
let receiverMode: 'fail' | 'ok' = 'fail'
const hits: ReceiverHit[] = []

let workspaceA: { id: string; name: string; slug: string }
let userReviewerA: { id: string }
let projectA: { id: string }
let apiKeyARaw: string

before(async () => {
  receiver = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* keep empty */
      }
      const headerId = req.headers['x-hitly-event-id']
      hits.push({ body, eventIdHeader: typeof headerId === 'string' ? headerId : null })
      if (receiverMode === 'fail') {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(RECEIVER_BODY_CANARY)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"success"}')
      }
    })
  })
  await new Promise<void>((resolve) => receiver!.listen(RECEIVER_PORT, '127.0.0.1', () => resolve()))

  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  // @ts-expect-error - Client vs Pool type mismatch, works at runtime
  db = drizzle(client)

  workspaceA = { id: newId('wsp'), name: 'M0h Dedupe WS', slug: `m0h-dupe-ws-${Date.now()}` }
  await db.insert(workspaces).values(workspaceA)
  userReviewerA = { id: newId('usr') }
  await db.insert(users).values({
    ...userReviewerA,
    name: userReviewerA.id,
    email: `${userReviewerA.id}@m0h-dupe.hitly.invalid`,
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
    name: 'M0h Dedupe Project',
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
    name: 'M0h Dedupe Key',
    createdAt: new Date(),
  })
})

after(async () => {
  if (receiver) await new Promise<void>((resolve) => receiver!.close(() => resolve()))
  await client?.end().catch(() => undefined)
})

async function ingestOne() {
  const result = await ingestApproval({
    apiKey: apiKeyARaw,
    body: {
      resumeUrl: `http://127.0.0.1:${RECEIVER_PORT}/resume`,
      runId: newId('run'),
      workflowName: 'm0h-dedupe',
      actionName: 'm0h-refund',
      args: { amount: 25 },
      metadata: { pageId: 'p1' },
    },
  })
  assert.ok(result.ok, `ingest should succeed: ${result.ok ? '' : result.error}`)
  return result.approval
}

async function latestDecisionRecord(approvalId: string) {
  const rows = await db
    .select()
    .from(decisionRecords)
    .where(and(eq(decisionRecords.approvalId, approvalId), eq(decisionRecords.workspaceId, workspaceA.id)))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1)
  assert.ok(rows[0], 'decision record exists')
  return rows[0]
}

test('failed decide: 3 attempts share one event id; no receiver body is stored or served', async () => {
  receiverMode = 'fail'
  hits.length = 0
  const approval = await ingestOne()

  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: userReviewerA.id,
    payload: { decision: 'accept' },
    workspaceId: workspaceA.id,
  })
  assert.equal(decided.status, 'failed_resume', 'all attempts 5xx -> failed_resume')
  assert.equal(hits.length, 3, 'default schedule: three in-process attempts')
  const ids = hits.map((h) => String(h.body.event_id))
  assert.equal(new Set(ids).size, 1, 'all three attempts reuse the same event id')
  assert.match(ids[0]!, /^evt_[0-9a-f]{32}$/)
  for (const h of hits) assert.equal(h.eventIdHeader, h.body.event_id, 'header matches body dedupe key')

  // M1 at the DB level: the 5xx page body must not be persisted...
  const record = await latestDecisionRecord(approval.id)
  assert.ok(record.resumeError, 'resumeError recorded')
  const resumeResponse = record.resumeResponse as Record<string, unknown> | null
  assert.ok(resumeResponse, 'resume response recorded')
  assert.equal(resumeResponse.body, null, 'receiver body must never be stored')
  assert.ok(!JSON.stringify(record).includes(RECEIVER_BODY_CANARY), 'canary must not reach decision_records')

  // ...nor served to reviewers via GET /approvals/:id.
  const detail = await getApprovalDetail({
    approvalId: approval.id,
    userId: userReviewerA.id,
    workspaceId: workspaceA.id,
    workspaceRole: 'member',
  })
  assert.ok(detail.ok)
  assert.ok(!JSON.stringify(detail).includes(RECEIVER_BODY_CANARY), 'canary must not reach the detail API')
  const served = detail.decisions.find((d) => d.id === record.id)
  assert.equal((served?.resumeResponse as Record<string, unknown> | null)?.body, null)
})

test('retryResume re-sends the SAME event id and completes the delivery', async () => {
  // Continue the previous approval: it is in failed_resume with three failed POSTs.
  // (Test order is deterministic in node:test; the approval id is re-discovered
  // from the receiver hits to keep this independent of fixture details.)
  assert.ok(hits.length >= 3)
  const failedEventId = String(hits[0]!.body.event_id)
  const requestIds = new Set(hits.map((h) => String(h.body.request_id)))
  assert.equal(requestIds.size, 1, 'all attempts targeted one approval')
  const approvalId = [...requestIds][0]!

  receiverMode = 'ok'
  const retry = await retryResume({ approvalId, workspaceId: workspaceA.id })
  assert.ok(!('error' in retry), `retryResume should succeed: ${'error' in retry ? retry.error : ''}`)
  assert.equal(retry.status, 'decided')

  assert.equal(hits.length, 4, 'the retry made exactly one more POST')
  const fourth = hits[3]!
  assert.equal(String(fourth.body.event_id), failedEventId, 'retryResume must reuse the event id (spec (e))')
  assert.equal(fourth.eventIdHeader, failedEventId)
})

test('a different approval gets a different event id (ids are per-approval, not global)', async () => {
  receiverMode = 'ok'
  const before = hits.length
  const approval = await ingestOne()
  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: userReviewerA.id,
    payload: { decision: 'accept' },
    workspaceId: workspaceA.id,
  })
  assert.equal(decided.status, 'decided')
  assert.equal(hits.length, before + 1)
  assert.notEqual(String(hits[before]!.body.event_id), String(hits[0]!.body.event_id))
})
