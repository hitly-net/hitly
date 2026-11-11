/**
 * GET /api/v1/approvals/:id must expose `answerSchema` as a top-level field
 * of the JSON body (the stored ask_user schema, or null when the request has
 * none). Nested `envelope.answerSchema` on the session path stays for existing
 * clients. Workspace/project scoping is unchanged.
 *
 * Mutants checked: omitting the top-level key; nesting only under envelope
 * / payload / metadata / hitl; omitting the key when the schema is absent
 * instead of returning null; leaking a foreign project's request.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { GET as getApprovalById } from '../app/api/v1/approvals/[id]/route'
import { decideApproval } from './approvals'
import { getApprovalDetail } from './approval-detail'
import {
  closeM0hFixture,
  createM0hFixture,
  ingestHttpAsk,
  startCapturingReceiver,
  type CapturingReceiver,
  type M0hFixture,
} from './m0h-fixture'
import { decodeTenantJson } from './tenant-crypto'

if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for tests')

let fixture: M0hFixture
let other: M0hFixture
let receiver: CapturingReceiver

before(async () => {
  fixture = await createM0hFixture()
  other = await createM0hFixture()
  receiver = await startCapturingReceiver()
})

after(async () => {
  await receiver?.close()
  if (fixture) await closeM0hFixture(fixture)
  if (other) await closeM0hFixture(other)
})

function here(...parts: string[]) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), ...parts)
}

async function readViaRest(approvalId: string, apiKey = fixture.apiKey): Promise<{
  status: number
  body: Record<string, unknown>
}> {
  const read = await getApprovalById(
    new Request(`https://hitly.example/api/v1/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
    { params: Promise.resolve({ id: approvalId }) },
  )
  return { status: read.status, body: (await read.json()) as Record<string, unknown> }
}

async function storedAnswerSchema(approvalId: string, workspaceId: string): Promise<unknown> {
  const [row] = await fixture.db.select({ envelope: approvals.envelope }).from(approvals).where(eq(approvals.id, approvalId))
  assert.ok(row, 'stored approval row must exist')
  const envelope = (await decodeTenantJson(workspaceId, row.envelope)) as { answerSchema?: unknown }
  return envelope.answerSchema ?? null
}

function assertTopLevelAnswerSchema(body: Record<string, unknown>, expected: unknown, label: string) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(body, 'answerSchema'),
    `${label}: answerSchema must be a top-level field of the GET response, got keys ${Object.keys(body).join(', ')}`,
  )
  assert.deepEqual(body.answerSchema, expected, `${label}: top-level answerSchema must match the stored schema`)
  const hitl = body.hitl
  if (hitl && typeof hitl === 'object') {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hitl, 'answerSchema'),
      `${label}: answerSchema must not live only inside hitl (hitl/response/v0 forbids extra properties)`,
    )
  }
}

test('GET /api/v1/approvals/:id source pins top-level answerSchema on both read paths', () => {
  const originSrc = fs.readFileSync(here('approvals.ts'), 'utf8')
  const detailSrc = fs.readFileSync(here('approval-detail.ts'), 'utf8')
  const originReturn = originSrc.slice(originSrc.indexOf('export async function getApprovalForOrigin'))
  const detailReturn = detailSrc.slice(detailSrc.indexOf('export async function getApprovalDetail'))
  assert.match(
    originReturn,
    /answerSchema:\s*envelope\.answerSchema\s*\?\?\s*null/,
    'API-key GET must return top-level answerSchema (null when absent)',
  )
  assert.match(
    detailReturn,
    /answerSchema:\s*redacted\.envelope\.answerSchema\s*\?\?\s*null/,
    'session GET must return top-level answerSchema from the redacted envelope (null when absent)',
  )
  assert.match(
    detailReturn,
    /typedAnswerFromPayload\(redacted\.decisions\[0\]\?\.payload\)/,
    'session GET must expose the typed answer from the latest decision payload',
  )
  assert.match(
    detailReturn,
    /\.\.\.\(answer !== undefined \? \{ answer \} : \{\}\)/,
    'session GET must omit answer when absent (never answer: null)',
  )
})

test('API-key GET returns stored answerSchema at the top level (real host, PG)', async () => {
  const created = await ingestHttpAsk(fixture, receiver.url, {
    actionName: 'ask_user',
    args: {},
    kind: 'question',
    prompt: 'Which venue?',
    answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
    allowedActions: { accept: false, reject: false, respond: true, ignore: true },
  })
  const stored = await storedAnswerSchema(created.id, fixture.workspaceId)
  assert.ok(stored && typeof stored === 'object', 'ingest must persist answerSchema on the envelope')

  const { status, body } = await readViaRest(created.id)
  assert.equal(status, 200)
  assertTopLevelAnswerSchema(body, stored, 'API-key GET with a stored schema')
  assert.ok(!('envelope' in body), 'requester view does not return envelope; top-level answerSchema is the public field')
})

test('API-key GET returns answerSchema: null when the request has no schema (real host, PG)', async () => {
  const created = await ingestHttpAsk(fixture, receiver.url, {
    actionName: 'deploy',
    args: { env: 'prod' },
    allowedActions: { accept: true, reject: true, respond: false, ignore: true },
  })
  assert.equal(await storedAnswerSchema(created.id, fixture.workspaceId), null, 'legacy ingest stores no schema')

  const { status, body } = await readViaRest(created.id)
  assert.equal(status, 200)
  assertTopLevelAnswerSchema(body, null, 'API-key GET with no stored schema')
  assert.equal(body.answerSchema, null, 'absent schema is null, not omitted')
})

test('session GET returns top-level answerSchema and keeps the nested envelope copy (real host, PG)', async () => {
  const withSchema = await ingestHttpAsk(fixture, receiver.url, {
    actionName: 'ask_user',
    args: {},
    kind: 'question',
    prompt: 'Ship on Tuesday?',
    answerSchema: { type: 'free_text' },
    allowedActions: { accept: false, reject: false, respond: true, ignore: true },
  })
  const stored = await storedAnswerSchema(withSchema.id, fixture.workspaceId)
  const detail = await getApprovalDetail({
    approvalId: withSchema.id,
    userId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    workspaceRole: 'member',
  })
  assert.ok(detail.ok)
  assertTopLevelAnswerSchema(detail as unknown as Record<string, unknown>, stored, 'session GET with a stored schema')
  assert.deepEqual(
    detail.envelope.answerSchema,
    stored,
    'nested envelope.answerSchema must stay for existing clients',
  )

  const noSchema = await ingestHttpAsk(fixture, receiver.url)
  const empty = await getApprovalDetail({
    approvalId: noSchema.id,
    userId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    workspaceRole: 'member',
  })
  assert.ok(empty.ok)
  assertTopLevelAnswerSchema(empty as unknown as Record<string, unknown>, null, 'session GET with no stored schema')
  assert.equal(empty.envelope.answerSchema, undefined, 'nested envelope key stays absent when there is no schema')
  assert.ok(!('answer' in empty), 'pending session GET must omit answer, never answer: null')
})

test('session GET returns top-level answer after a typed respond (real host, PG)', async () => {
  const created = await ingestHttpAsk(fixture, receiver.url, {
    actionName: 'ask_user',
    args: {},
    kind: 'question',
    prompt: 'Which auth methods?',
    answerSchema: { type: 'multi_choice', options: ['secret', 'forms', 'push', 'sso'] },
    allowedActions: { accept: false, reject: false, respond: true, ignore: true },
  })
  const typed = { kind: 'multi', value: ['secret', 'forms', 'push', 'sso'] }
  const decided = await decideApproval({
    approvalId: created.id,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: { decision: 'respond', answer: typed },
  })
  assert.equal((decided as { error?: string }).error, undefined, `decide must succeed, got ${JSON.stringify(decided)}`)

  const detail = await getApprovalDetail({
    approvalId: created.id,
    userId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    workspaceRole: 'member',
  })
  assert.ok(detail.ok)
  assert.deepEqual(
    (detail as { answer?: unknown }).answer,
    typed,
    'session GET must return the typed answer at the top level for the mobile detail screen',
  )
  assert.ok(detail.answerSchema && typeof detail.answerSchema === 'object')
})

test('GET /api/v1/approvals/:id does not leak answerSchema across projects (real host, PG)', async () => {
  const created = await ingestHttpAsk(fixture, receiver.url, {
    actionName: 'ask_user',
    args: {},
    kind: 'question',
    prompt: 'Secret venue?',
    answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
    allowedActions: { accept: false, reject: false, respond: true, ignore: true },
  })

  const { status, body } = await readViaRest(created.id, other.apiKey)
  assert.equal(status, 404, 'a key from another project must not read this request')
  assert.ok(!('answerSchema' in body), `404 must not leak answerSchema, got ${JSON.stringify(body)}`)
  assert.deepEqual(body, { error: 'Not found' })

  const foreignDetail = await getApprovalDetail({
    approvalId: created.id,
    userId: other.reviewerId,
    workspaceId: other.workspaceId,
    workspaceRole: 'member',
  })
  assert.equal(foreignDetail.ok, false)
  assert.equal(foreignDetail.status, 404)
  assert.ok(!('answerSchema' in foreignDetail), 'session 404 must not leak answerSchema')
})
