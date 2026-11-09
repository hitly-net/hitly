/**
 * M0h item 6 (PR hitly#106): opt-in HTTP lifecycle events wired to the host.
 * Real Postgres + a capturing localhost receiver.
 *
 * An opted-IN request (lifecycleEvents at ingest) receives presented, opened,
 * cancelled and expired POSTs in addition to the final decision, each with a
 * stable per-(approval,event) event id. An opted-OUT request receives ONLY
 * the single final-decision POST (n8n Wait default preserved). Delivery is
 * best-effort: a failing lifecycle receiver never breaks the reviewer action.
 *
 * `opened` is exercised through the same deliverApprovalLifecycleEvent call
 * the opens route makes (route-level session plumbing is out of scope here);
 * presented/cancelled/expired go through their real host call sites.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { cancelApproval, decideApproval, markApprovalPresented } from './approvals'
import { deliverApprovalLifecycleEvent } from './lifecycle-delivery'
import { expireOverdueApprovals } from './housekeeping/jobs'
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

const ALL_LIFECYCLE = ['presented', 'opened', 'cancelled', 'expired']

test('opted-in request receives presented, opened, cancelled and expired callbacks', async () => {
  const approval = await ingestHttpAsk(fixture, receiver.url, {
    lifecycleEvents: ALL_LIFECYCLE,
    externalUrls: [{ url: 'https://context.example/policy', ref: 'pol1', label: 'Policy' }],
  })

  const shown = await markApprovalPresented({
    approvalId: approval.id,
    actorUserId: fixture.reviewerId,
    workspaceRole: 'member',
    workspaceId: fixture.workspaceId,
  })
  assert.ok(!('error' in shown))
  assert.ok(shown.presentedAt, 'first-show recorded')

  // Same call the opens route makes after recordContextOpen (with the row's
  // stored origin, as the route passes it).
  const rows = await fixture.db
    .select({ origin: approvals.origin })
    .from(approvals)
    .where(eq(approvals.id, approval.id))
    .limit(1)
  await deliverApprovalLifecycleEvent({
    approval: {
      id: approval.id,
      projectId: fixture.projectId,
      plugin: 'http',
      origin: rows[0]!.origin,
    },
    workspaceId: fixture.workspaceId,
    type: 'opened',
    extraMetadata: { ref: 'pol1', url: 'https://context.example/policy' },
  })

  await cancelApproval({ approvalId: approval.id, actorUserId: fixture.reviewerId, workspaceId: fixture.workspaceId })

  const hits = hitsFor(approval.id)
  const types = hits.map((h) => String(h.body.type))
  assert.ok(types.includes('presented'), `presented POST expected, got ${JSON.stringify(types)}`)
  assert.ok(types.includes('opened'), `opened POST expected, got ${JSON.stringify(types)}`)
  assert.ok(types.includes('cancelled'), `cancelled POST expected, got ${JSON.stringify(types)}`)
  assert.equal(hits.length, 3, 'exactly one POST per lifecycle event (no decision here)')

  const opened = hits.find((h) => h.body.type === 'opened')!
  assert.deepEqual(
    (opened.body.metadata as Record<string, unknown>).ref,
    'pol1',
    'opened carries the opened context ref',
  )

  // Stable ids: evt_-shaped, header == body, unique per logical event.
  const ids = hits.map((h) => String(h.body.event_id))
  for (const h of hits) {
    assert.match(String(h.body.event_id), /^evt_[0-9a-f]{32}$/)
    assert.equal(h.headers['x-hitly-event-id'], h.body.event_id, 'header dedupe key matches body')
  }
  assert.equal(new Set(ids).size, ids.length, 'distinct logical events, distinct ids')

  // Idempotence: a second mark-presented is a no-op - no second POST.
  await markApprovalPresented({
    approvalId: approval.id,
    actorUserId: fixture.reviewerId,
    workspaceRole: 'member',
    workspaceId: fixture.workspaceId,
  })
  assert.equal(hitsFor(approval.id).filter((h) => h.body.type === 'presented').length, 1)
})

test('expired requests get an opt-in expired POST from the housekeeping sweep', async () => {
  const approval = await ingestHttpAsk(fixture, receiver.url, { lifecycleEvents: ['expired'] })
  // Force the row overdue, then run the real housekeeping job.
  await fixture.db
    .update(approvals)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, fixture.workspaceId)))
  // The sweep manages its own tenant context per workspace.
  const result = await expireOverdueApprovals()
  assert.ok(result.expired >= 1, 'the sweep expired the row')
  const hit = hitsFor(approval.id).find((h) => h.body.type === 'expired')
  assert.ok(hit, 'expired POST delivered')
  assert.match(String(hit.body.event_id), /^evt_[0-9a-f]{32}$/)
  const rows = await fixture.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approval.id)).limit(1)
  assert.equal(rows[0]!.status, 'expired')
})

test('default stays the single final POST: opted-out receives only decided', async () => {
  // No lifecycleEvents at ingest: presented/cancelled must NOT POST...
  const quiet = await ingestHttpAsk(fixture, receiver.url)
  await markApprovalPresented({
    approvalId: quiet.id,
    actorUserId: fixture.reviewerId,
    workspaceRole: 'member',
    workspaceId: fixture.workspaceId,
  })
  await cancelApproval({ approvalId: quiet.id, actorUserId: fixture.reviewerId, workspaceId: fixture.workspaceId })
  assert.equal(hitsFor(quiet.id).length, 0, 'opted-out: no lifecycle POSTs')

  // ...and a decide sends exactly one POST (the n8n Wait contract).
  const decidedItem = await ingestHttpAsk(fixture, receiver.url, { lifecycleEvents: ALL_LIFECYCLE })
  const decided = await decideApproval({
    approvalId: decidedItem.id,
    actorUserId: fixture.reviewerId,
    payload: { decision: 'accept' },
    workspaceId: fixture.workspaceId,
  })
  if ('error' in decided) throw new Error(`decide failed: ${decided.error}`)
  const hits = hitsFor(decidedItem.id)
  const types = hits.map((h) => String(h.body.type))
  assert.equal(types.filter((t) => t === 'decided').length, 1, 'exactly one decided POST')
  // Opted-in ALSO got its presented POST (implicit on decide) - the final
  // decision stays, lifecycle is additive, never replacing it.
  assert.ok(types.includes('presented'))
})

test('a failing lifecycle receiver never fails the reviewer action', async () => {
  receiver.setMode('fail')
  try {
    const approval = await ingestHttpAsk(fixture, receiver.url, { lifecycleEvents: ['presented'] })
    const shown = await markApprovalPresented({
      approvalId: approval.id,
      actorUserId: fixture.reviewerId,
      workspaceRole: 'member',
      workspaceId: fixture.workspaceId,
    })
    assert.ok(!('error' in shown), 'presented still succeeds with a 5xx receiver')
    assert.ok(shown.presentedAt)
  } finally {
    receiver.setMode('ok')
  }
})
