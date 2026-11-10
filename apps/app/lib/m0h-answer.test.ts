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
import { approvals, decisionRecords } from '@hitly/db/schema'
import { POST as ingestRoute } from '../app/api/v1/approvals/route'
import { newId } from './ids'
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

test('an approval without an answer sends decided with the answer key OMITTED, never null', async () => {
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
  // PM ruling on hitl-spec 4.2 (Test M1): no answer means NO answer key -
  // a decided callback must never carry `answer: null`.
  assert.ok(!('answer' in hit.body), `decided callback must OMIT answer, got ${JSON.stringify(hit.body.answer)}`)
})

test('ask_user with a stored schema: persisted spec type, host-validated answer, answered callback', async () => {
  const approval = await ingestHttpAsk(fixture, receiver.url, {
    kind: 'question',
    actionName: 'ask_user',
    args: {},
    prompt: 'Which venue?',
    answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
    allowedActions: { accept: false, reject: false, respond: true, ignore: true },
  })

  // Ingest persisted the schema (mapped to the SPEC name) and the prompt.
  const [row] = await fixture.db
    .select({ envelope: approvals.envelope })
    .from(approvals)
    .where(eq(approvals.id, approval.id))
  const envelope = (await decodeTenantJson(fixture.workspaceId, row!.envelope)) as {
    prompt?: string
    answerSchema: { type: string; options?: Array<{ value: string; label: string }> }
  }
  assert.equal(envelope.prompt, 'Which venue?')
  assert.equal(envelope.answerSchema.type, 'single', 'stored type is the spec name, not the MCP alias')
  assert.deepEqual(envelope.answerSchema.options, [
    { value: 'Hall A', label: 'Hall A' },
    { value: 'Hall B', label: 'Hall B' },
  ])

  const decide = (payload: Record<string, unknown>) =>
    decideApproval({
      approvalId: approval.id,
      actorUserId: fixture.reviewerId,
      payload: parseDecisionBody(payload) as never,
      workspaceId: fixture.workspaceId,
    })

  // Host refusals (spec 7) while the request is still open.
  const bare = (await decide({ decision: 'respond', response: 'Hall A' })) as { error?: string; status?: number }
  assert.equal(bare.status, 400, 'a bare response is refused when a schema is stored')
  assert.match(String(bare.error), /response/)
  const wrongKind = (await decide({ decision: 'respond', answer: { kind: 'single_choice', value: 'Hall A' } })) as {
    status?: number
    error?: string
  }
  assert.equal(wrongKind.status, 400, 'the alias kind is refused: kind must equal the stored spec type')
  assert.match(String(wrongKind.error), /answer.kind/)
  const unknown = (await decide({ decision: 'respond', answer: { kind: 'single', value: 'Hall C' } })) as { status?: number }
  assert.equal(unknown.status, 400, 'option not in the stored options')

  // The exact payload the web form POSTs.
  const before = receiver.hits.length
  const decided = (await decide({ decision: 'respond', answer: { kind: 'single', value: 'Hall B' } })) as {
    error?: string
    status?: string
  }
  assert.equal(decided.error, undefined, `valid typed answer must decide, got ${decided.error}`)
  assert.equal(decided.status, 'decided')

  assert.equal(receiver.hits.length, before + 1, 'exactly one callback')
  const hit = receiver.hits[before]!
  assert.equal(hit.body.type, 'answered')
  assert.equal(hit.body.state, 'answered')
  assert.equal(hit.body.decision, 'respond')
  assert.deepEqual(hit.body.answer, { kind: 'single', value: 'Hall B' }, 'typed answer reaches the sink verbatim')
  assert.equal(hit.body.response, undefined, 'no free-text substitute alongside the typed answer')
})

test('HTTP ingest refuses ask_user with a binary answerSchema: 400, nothing created', async () => {
  const rowsBefore = await fixture.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.projectId, fixture.projectId), eq(approvals.workspaceId, fixture.workspaceId)))
  // binary is the request_approval approve/reject shape; ask_user must not
  // accept it over HTTP either (MCP ask_user already refuses it identically).
  const askBinary = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: newId('run'),
        projectId: fixture.projectId,
        kind: 'question',
        actionName: 'ask_user',
        prompt: 'Ship it?',
        answerSchema: { type: 'binary' },
        allowedActions: { accept: false, reject: false, respond: true, ignore: true },
      }),
    }),
  )
  assert.equal(askBinary.status, 400, 'ask_user + binary is refused at the HTTP route')
  const body = (await askBinary.json()) as { error?: string }
  assert.match(String(body.error), /answerSchema\.type must be one of: text, single, multi, number/)
  const rowsAfterRefusal = await fixture.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.projectId, fixture.projectId), eq(approvals.workspaceId, fixture.workspaceId)))
  assert.equal(rowsAfterRefusal.length, rowsBefore.length, 'the refused ask created no row')

  // request_approval keeps its binary approve/reject shape over the same route.
  const approvalBinary = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: newId('run'),
        projectId: fixture.projectId,
        actionName: 'request_approval',
        answerSchema: { type: 'binary' },
      }),
    }),
  )
  assert.equal(approvalBinary.status, 200, 'request_approval with binary still ingests')
  const created = await fixture.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.projectId, fixture.projectId), eq(approvals.workspaceId, fixture.workspaceId)))
  assert.equal(created.length, rowsBefore.length + 1, 'only the request_approval row was added')
})
