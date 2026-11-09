/**
 * M0h item 7 (PR hitly#106): typed answers (ask_user) must be CARRIED and
 * VALIDATED by parseDecisionBody - never silently dropped. Real Postgres for
 * the end-to-end leg: a respond decision with an answer must land in the
 * decision record AND reach the receiver as a single `answered` POST with the
 * typed value intact. Reverting the parseDecisionBody fix fails this file.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { and, desc, eq } from 'drizzle-orm'
import { decisionRecords } from '@hitly/db/schema'
import { decideApproval, parseDecisionBody } from './approvals'
import { decodeTenantJson } from './tenant-crypto'
import {
  closeM0hFixture,
  createM0hFixture,
  ingestHttpAsk,
  startCapturingReceiver,
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

test('parseDecisionBody carries the typed answer through (never dropped)', () => {
  const payload = parseDecisionBody({ decision: 'respond', answer: { kind: 'single_choice', value: 'blue' } })
  assert.ok(payload, 'valid answer must not invalidate the decision')
  assert.deepEqual(payload.answer, { kind: 'single_choice', value: 'blue' })
  assert.equal(payload.decision, 'respond')
})

test('parseDecisionBody refuses malformed answers instead of dropping them', () => {
  assert.equal(parseDecisionBody({ decision: 'respond', answer: 'blue' }), null, 'bare string is not a typed answer')
  assert.equal(parseDecisionBody({ decision: 'respond', answer: ['a'] }), null, 'array is not a typed answer')
  assert.equal(parseDecisionBody({ decision: 'respond', answer: { value: 'x' } }), null, 'kind required')
  assert.equal(parseDecisionBody({ decision: 'respond', answer: { kind: '', value: 'x' } }), null, 'blank kind refused')
  assert.equal(parseDecisionBody({ decision: 'respond', answer: { kind: 'free_text' } }), null, 'value required')
  assert.equal(
    parseDecisionBody({ decision: 'respond', answer: { kind: 'free_text', value: Number.NaN } }),
    null,
    'non-JSON value refused',
  )
})

test('absent answer stays absent: decided payloads unchanged', () => {
  const payload = parseDecisionBody({ decision: 'accept', reason: 'ok' })
  assert.ok(payload)
  assert.equal('answer' in payload, false)
})

test('decide with a typed answer POSTs one answered callback with the answer intact', async () => {
  const approval = await ingestHttpAsk(fixture, receiver.url, {
    allowedActions: { accept: true, reject: true, respond: true },
  })
  const before = receiver.hits.length
  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: fixture.reviewerId,
    payload: { decision: 'respond', answer: { kind: 'single_choice', value: 'blue' } },
    workspaceId: fixture.workspaceId,
  })
  if ('error' in decided) throw new Error(`decide failed: ${decided.error}`)
  assert.equal(decided.status, 'decided')

  assert.equal(receiver.hits.length, before + 1, 'exactly one callback')
  const hit = receiver.hits[before]!
  assert.equal(hit.body.type, 'answered')
  assert.equal(hit.body.decision, 'respond')
  assert.deepEqual(hit.body.answer, { kind: 'single_choice', value: 'blue' }, 'answer must reach the receiver intact')
  assert.equal(hit.body.id, approval.id)

  // The audit trail must keep it too (never dropped on the way to storage).
  const rows = await fixture.db
    .select()
    .from(decisionRecords)
    .where(and(eq(decisionRecords.approvalId, approval.id), eq(decisionRecords.workspaceId, fixture.workspaceId)))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1)
  assert.ok(rows[0], 'decision record exists')
  const stored = (await decodeTenantJson(fixture.workspaceId, rows[0]!.payload)) as Record<string, unknown>
  assert.deepEqual(stored.answer, { kind: 'single_choice', value: 'blue' })
})

test('an approval without an answer sends decided (answer null), as before', async () => {
  const approval = await ingestHttpAsk(fixture, receiver.url)
  const before = receiver.hits.length
  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: fixture.reviewerId,
    payload: { decision: 'accept' },
    workspaceId: fixture.workspaceId,
  })
  if ('error' in decided) throw new Error(`decide failed: ${decided.error}`)
  assert.equal(receiver.hits.length, before + 1)
  const hit = receiver.hits[before]!
  assert.equal(hit.body.type, 'decided')
  assert.equal(hit.body.answer, null)
})
