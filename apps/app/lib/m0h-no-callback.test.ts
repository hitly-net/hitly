/**
 * No callback_url => HITLy attempts NO callback/resume (prod incident rule).
 * Real Postgres + a capturing localhost receiver.
 *
 * An HTTP request ingested WITHOUT resumeUrl must:
 * - store no resumeUrl on the origin handle,
 * - complete a reviewer decision with ZERO outbound calls (never failed_resume),
 * - read back via the API key as decided/answered with callbackDelivery 'none'.
 *
 * A request ingested WITH resumeUrl keeps today's behaviour exactly: one
 * decided POST to the receiver and no callbackDelivery field on the read.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { decideApproval, getApprovalForOrigin, ingestApproval, markApprovalPresented, parseDecisionBody } from './approvals'
import { decodeTenantJson } from './tenant-crypto'
import {
  closeM0hFixture,
  createM0hFixture,
  ingestHttpAsk,
  startCapturingReceiver,
  type CapturedHit,
  type CapturingReceiver,
  type M0hFixture,
} from './m0h-fixture'

if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for tests')

let fixture: M0hFixture
let receiver: CapturingReceiver

before(async () => {
  fixture = await createM0hFixture()
  receiver = await startCapturingReceiver()
})

after(async () => {
  await receiver?.close()
  if (fixture) await closeM0hFixture(fixture)
})

function hitsFor(approvalId: string): CapturedHit[] {
  return receiver.hits.filter((h) => String(h.body.request_id ?? h.body.id) === approvalId)
}

async function ingestWithoutResume(body: Record<string, unknown> = {}): Promise<string> {
  const result = await ingestApproval({
    apiKey: fixture.apiKey,
    body: {
      runId: `run-nocb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workflowName: 'nocb-flow',
      actionName: 'nocb-refund',
      args: { amount: 7 },
      ...body,
    },
  })
  if (!result.ok) throw new Error(`ingest failed: ${result.error}`)
  return result.approval.id
}

async function storedResumeHandle(approvalId: string): Promise<Record<string, unknown>> {
  const rows = await fixture.db.select({ origin: approvals.origin }).from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  const origin = await decodeTenantJson(fixture.workspaceId, rows[0]!.origin)
  return (origin as { resumeHandle?: Record<string, unknown> }).resumeHandle ?? {}
}

test('ingest without resumeUrl is accepted and stores none on the origin handle', async () => {
  const id = await ingestWithoutResume()
  const handle = await storedResumeHandle(id)
  assert.equal('resumeUrl' in handle, false, 'no resumeUrl is stored')
  assert.ok(handle.metadata, 'the metadata bag still lands')
  // Open request: no callbackDelivery yet (nothing has been decided).
  const open = await getApprovalForOrigin({ apiKey: fixture.apiKey, approvalId: id })
  if (!open.ok) throw new Error(open.error)
  assert.equal(open.status, 'pending')
  assert.equal((open as { callbackDelivery?: unknown }).callbackDelivery, undefined)
  assert.equal(receiver.hits.length, 0, 'ingest alone makes no outbound call')
})

test('approve on a no-callback request: zero outbound calls, stays decided, read says none', async () => {
  const id = await ingestWithoutResume()

  const shown = await markApprovalPresented({
    approvalId: id,
    actorUserId: fixture.reviewerId,
    workspaceRole: 'member',
    workspaceId: fixture.workspaceId,
  })
  assert.ok(!('error' in shown), 'presented still works without a callback')

  const payload = parseDecisionBody({ decision: 'accept' })
  assert.ok(payload)
  const decided = await decideApproval({
    approvalId: id,
    actorUserId: fixture.reviewerId,
    payload,
    workspaceId: fixture.workspaceId,
  })
  if ('error' in decided) throw new Error(`decide failed: ${decided.error}`)
  assert.equal(decided.status, 'decided', 'never failed_resume when no resumeUrl exists')
  assert.equal(decided.resumeError, null)
  assert.equal(decided.resumeResponse, null, 'skipped resume stores nothing')
  assert.equal(hitsFor(id).length, 0, 'ZERO outbound calls for the decision')

  const read = await getApprovalForOrigin({ apiKey: fixture.apiKey, approvalId: id })
  if (!read.ok) throw new Error(read.error)
  assert.equal(read.status, 'decided')
  assert.equal(read.decision, 'accept')
  assert.equal(read.hitl?.status, 'answered')
  assert.equal(read.hitl?.value, 'approve')
  assert.equal((read as { callbackDelivery?: unknown }).callbackDelivery, 'none', 'delivery reported as none, not failed')
})

test('ask_user answer on a no-callback request: zero outbound calls, answered read', async () => {
  const id = await ingestWithoutResume({
    kind: 'question',
    actionName: 'ask_user',
    prompt: 'Which day works?',
    allowedActions: { accept: false, reject: false, respond: true, ignore: true },
  })
  const payload = parseDecisionBody({ decision: 'respond', response: 'Saturday' })
  assert.ok(payload)
  const answered = await decideApproval({
    approvalId: id,
    actorUserId: fixture.reviewerId,
    payload,
    workspaceId: fixture.workspaceId,
  })
  if ('error' in answered) throw new Error(`decide failed: ${answered.error}`)
  assert.equal(answered.status, 'decided')
  assert.equal(answered.resumeError, null)
  assert.equal(hitsFor(id).length, 0, 'ZERO outbound calls for the answer')

  const read = await getApprovalForOrigin({ apiKey: fixture.apiKey, approvalId: id })
  if (!read.ok) throw new Error(read.error)
  assert.equal(read.response, 'Saturday')
  assert.equal(read.hitl?.status, 'answered')
  assert.equal(read.hitl?.value, 'Saturday')
  assert.equal((read as { callbackDelivery?: unknown }).callbackDelivery, 'none')
})

test('with resumeUrl behaviour is unchanged: one decided POST, no callbackDelivery field', async () => {
  const approval = await ingestHttpAsk(fixture, receiver.url)
  const handle = await storedResumeHandle(approval.id)
  assert.equal(handle.resumeUrl, `${receiver.url}/resume`, 'resumeUrl still stored')

  const payload = parseDecisionBody({ decision: 'accept' })
  assert.ok(payload)
  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: fixture.reviewerId,
    payload,
    workspaceId: fixture.workspaceId,
  })
  if ('error' in decided) throw new Error(`decide failed: ${decided.error}`)
  assert.equal(decided.status, 'decided')

  const hits = hitsFor(approval.id)
  assert.equal(hits.length, 1, 'exactly the single final-decision POST')
  assert.equal(String(hits[0]!.body.type), 'decided')

  const read = await getApprovalForOrigin({ apiKey: fixture.apiKey, approvalId: approval.id })
  if (!read.ok) throw new Error(read.error)
  assert.equal(read.hitl?.status, 'answered')
  assert.equal((read as { callbackDelivery?: unknown }).callbackDelivery, undefined, 'callback reads stay unchanged')
})
