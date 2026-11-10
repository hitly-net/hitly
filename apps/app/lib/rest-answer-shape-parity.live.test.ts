/**
 * REST get-decision answer shape must match MCP get_decision (hitl-spec 4.2).
 *
 * The PM ruling makes the typed ask_user answer a core top-level `answer`
 * field of the hitl/response/v0 view. This suite pins the REST side to the
 * MCP side on the real host:
 * - REST `body.hitl.answer` and the MCP get_decision result `answer` are the
 *   same value, at the same place (top level of the hitl/response/v0 object),
 *   verbatim for unicode, multiline, empty-string and long answers;
 * - `answer` is OMITTED when absent - `answer: null` appears nowhere in the
 *   REST read (envelope, hitl view or _meta) nor in the MCP result, even when
 *   a legacy decision row stores a literal null;
 * - respond with no reply text OMITS `value` on both surfaces (never
 *   `value: ""`), while an explicit empty-string reply stays `value: ""`;
 * - the deprecated `_meta["net.hitly/answer"]` HITLy vendor alias carries
 *   exactly the same value as top-level `answer` and is absent whenever
 *   `answer` is absent.
 *
 * Real host on Postgres, no FakeHost (same style as the #129 live test):
 * ingest through the real path, decide through the real decideApproval, read
 * through the real GET /api/v1/approvals/:id route and the real MCP tool loop.
 * Mutants checked: (1) respond defaulting value to ""; (2) emitting
 * answer: null; (3) dropping/diverging the _meta alias while answer exists;
 * (4) removing the top-level answer from the hitl view (old REST nesting);
 * (5) emitting a top-level value alongside a typed answer on REST or MCP
 * (PM ruling: answer is the ONLY carrier); (6) callbacks sending answer: null
 * instead of omitting the key (decided POST and lifecycle bodies).
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { decisionRecords } from '@hitly/db/schema'
import { GET as getApprovalById } from '../app/api/v1/approvals/[id]/route'
import { decideApproval } from './approvals'
import { encodeTenantJson } from './tenant-crypto'
import {
  closeM0hFixture,
  createM0hFixture,
  ingestHttpAsk,
  startCapturingReceiver,
  type CapturingReceiver,
  type M0hFixture,
} from './m0h-fixture'
import { HttpHostClient } from '../../mcp/src/host-client.ts'
import { startHarness, structured } from '../../mcp/src/test-helpers.ts'

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

/** Real GET /api/v1/approvals/:id handler behind the MCP host client. */
function fetchToHost(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input)
  const match = /^\/api\/v1\/approvals\/([^/?#]+)$/.exec(url.pathname)
  if (!match || (init?.method ?? 'GET').toUpperCase() !== 'GET') {
    return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected host call' }), { status: 404 }))
  }
  return getApprovalById(new Request(input, init), { params: Promise.resolve({ id: decodeURIComponent(match[1]) }) })
}

async function askAsBot(overrides: Record<string, unknown> = {}): Promise<string> {
  return (
    await ingestHttpAsk(fixture, receiver.url, {
      actionName: 'ask_user',
      args: {},
      kind: 'question',
      prompt: 'Which delivery slot works?',
      answerSchema: { type: 'free_text' },
      allowedActions: { accept: false, reject: false, respond: true, ignore: true },
      ...overrides,
    })
  ).id
}

async function decide(approvalId: string, payload: Parameters<typeof decideApproval>[0]['payload']): Promise<void> {
  const decided = await decideApproval({
    approvalId,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload,
  })
  assert.equal((decided as { error?: string }).error, undefined, `decide must succeed, got ${JSON.stringify(decided)}`)
}

async function readViaRest(approvalId: string): Promise<Record<string, unknown>> {
  const read = await getApprovalById(
    new Request(`https://hitly.example/api/v1/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${fixture.apiKey}` },
    }),
    { params: Promise.resolve({ id: approvalId }) },
  )
  assert.equal(read.status, 200)
  return (await read.json()) as Record<string, unknown>
}

async function readViaMcp(approvalId: string): Promise<Record<string, unknown>> {
  const h = await startHarness({
    deps: { hostFor: (key) => new HttpHostClient('https://hitly.example', key, fetchToHost) },
  })
  try {
    const mcp = await h.client(fixture.apiKey)
    return structured(await mcp.callTool({ name: 'get_decision', arguments: { requestId: approvalId } }))
  } finally {
    await h.close()
  }
}

function hitlView(body: Record<string, unknown>): Record<string, unknown> {
  assert.ok(body.hitl && typeof body.hitl === 'object', 'hitl view must exist for a decided request')
  return body.hitl as Record<string, unknown>
}

/** Locate any `answer` (or vendor alias) key stored as a literal JSON null. */
function findNullAnswer(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = findNullAnswer(item, `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'answer' || key === 'net.hitly/answer') && item === null) return `${path}.${key}`
      const hit = findNullAnswer(item, `${path}.${key}`)
      if (hit) return hit
    }
  }
  return null
}

// The spec 4.2 verbatim matrix: unicode, line breaks, an intentionally empty
// answer and a long answer. Each must survive REST and MCP identically.
// Merge adaptation (#130 into #134): the host now re-validates the answer at
// decide against the STORED schema (hitl-spec 7) - `kind` must be the stored
// spec type, never the MCP input alias. The ingest keeps the alias (`free_text`
// -> stored `text`), so these decide with the canonical kind.
const TYPED_VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['unicode', { kind: 'text', value: 'Übermorgen um 13:00 ✓ 日本語 🚀', note: 'ünïcode' }],
  ['multiline', { kind: 'text', value: 'line one\nline two\r\nline three\n', confidence: 0.5 }],
  ['empty string', { kind: 'text', value: '' }],
  ['long', { kind: 'text', value: 'ünïcode 🚀 long answer '.repeat(2_000) }],
]

for (const [label, typed] of TYPED_VARIANTS) {
  test(`REST and MCP return the identical answer shape for a ${label} typed answer (real host, PG)`, async () => {
    const approvalId = await askAsBot()
    await decide(approvalId, { decision: 'respond', answer: typed })

    const body = await readViaRest(approvalId)
    const hitl = hitlView(body)
    assert.equal(hitl.status, 'answered')
    assert.deepEqual(hitl.answer, typed, `REST hitl view must carry the ${label} answer verbatim at top level`)

    const got = await readViaMcp(approvalId)
    assert.equal(got.status, 'answered')
    assert.deepEqual(got.answer, typed, `MCP get_decision must return the ${label} answer verbatim`)
    assert.deepEqual(hitl.answer, got.answer, 'REST and MCP must return the same answer shape')

    // Deprecated vendor alias: same value as top-level answer, never diverging.
    const meta = hitl._meta as Record<string, unknown> | undefined
    assert.ok(meta && 'net.hitly/answer' in meta, 'deprecated alias must be present while answer is present')
    assert.deepEqual(meta['net.hitly/answer'], hitl.answer, 'alias must carry exactly the same value as top-level answer')

    // No answer-shaped null anywhere on either surface.
    assert.equal(findNullAnswer(body), null, 'REST read must never carry answer: null')
    assert.equal(findNullAnswer(got), null, 'MCP result must never carry answer: null')
  })
}

test('respond with no reply text omits value on REST and MCP; never value: "" (real host, PG)', async () => {
  const approvalId = await askAsBot()
  await decide(approvalId, { decision: 'respond', answer: { kind: 'text', value: 'No reply text needed' } })

  const body = await readViaRest(approvalId)
  const hitl = hitlView(body)
  assert.equal(hitl.status, 'answered')
  assert.ok(!('value' in hitl), `REST hitl view must OMIT value when the reviewer sent no reply text, got ${JSON.stringify(hitl.value)}`)

  const got = await readViaMcp(approvalId)
  assert.equal(got.status, 'answered')
  assert.ok(!('value' in got), `MCP result must OMIT value when the reviewer sent no reply text, got ${JSON.stringify(got.value)}`)
})

test('respond with an explicit empty-string reply keeps value: "" on both surfaces (real host, PG)', async () => {
  // Merge adaptation: a stored-schema respond must carry answer{kind,value},
  // never a free-text response (hitl-spec 7). This reply-text scenario lives
  // on the legacy no-schema path, where it tests exactly the same shape.
  const approvalId = await askAsBot({ answerSchema: undefined })
  await decide(approvalId, { decision: 'respond', response: '' })

  const hitl = hitlView(await readViaRest(approvalId))
  assert.equal(hitl.value, '', 'explicit empty reply text is verbatim data, not an omission')
  const got = await readViaMcp(approvalId)
  assert.equal(got.value, '', 'MCP must keep the explicit empty reply text too')
})

test('accept still maps to value approve on both surfaces (regression pin)', async () => {
  const approvalId = await askAsBot({
    actionName: 'deploy',
    args: { env: 'prod' },
    allowedActions: { accept: true, reject: true, respond: false, ignore: true },
  })
  await decide(approvalId, { decision: 'accept' })

  const hitl = hitlView(await readViaRest(approvalId))
  assert.equal(hitl.value, 'approve')
  const got = await readViaMcp(approvalId)
  assert.equal(got.value, 'approve')
})

test('no typed answer: answer and the deprecated alias are ABSENT, never null, on REST and MCP (real host, PG)', async () => {
  // Merge adaptation: reply-text decisions (no typed answer) belong to the
  // legacy no-schema path; a stored-schema respond requires answer{kind,value}.
  const approvalId = await askAsBot({ answerSchema: undefined })
  await decide(approvalId, { decision: 'respond', response: 'Approved, no question typed' })

  const body = await readViaRest(approvalId)
  const hitl = hitlView(body)
  assert.ok(!('answer' in hitl), 'hitl view must omit answer when none was typed')
  assert.ok(!('answer' in body), 'read envelope must omit answer when none was typed')
  const meta = hitl._meta as Record<string, unknown> | undefined
  assert.ok(!(meta && 'net.hitly/answer' in meta), 'deprecated alias must be absent whenever answer is absent')

  const got = await readViaMcp(approvalId)
  assert.ok(!('answer' in got), 'MCP result must omit answer when none was typed')
  assert.equal(findNullAnswer(body), null, 'no answer: null anywhere in the REST read')
  assert.equal(findNullAnswer(got), null, 'no answer: null anywhere in the MCP result')
})

test('a stored literal null answer is treated as absent everywhere (real host, PG)', async () => {
  // Merge adaptation: the legacy-row simulation is a reply-text decision, so
  // it runs on the no-schema path (a stored-schema respond requires answer).
  const approvalId = await askAsBot({ answerSchema: undefined })
  await decide(approvalId, { decision: 'respond', response: 'Legacy row simulation' })
  // Simulate a legacy decision row whose stored payload carries answer: null.
  await fixture.db
    .update(decisionRecords)
    .set({ payload: await encodeTenantJson(fixture.workspaceId, { decision: 'respond', response: 'Legacy row simulation', answer: null }) })
    .where(eq(decisionRecords.approvalId, approvalId))

  const body = await readViaRest(approvalId)
  assert.ok(!('answer' in body), 'read envelope must treat stored null as absent')
  const hitl = hitlView(body)
  assert.ok(!('answer' in hitl), 'hitl view must treat stored null as absent')
  const meta = hitl._meta as Record<string, unknown> | undefined
  assert.ok(!(meta && 'net.hitly/answer' in meta), 'deprecated alias must treat stored null as absent')
  assert.equal(findNullAnswer(body), null, 'REST read must never surface answer: null')

  const got = await readViaMcp(approvalId)
  assert.ok(!('answer' in got), 'MCP result must treat stored null as absent')
  assert.equal(findNullAnswer(got), null, 'MCP result must never surface answer: null')
})

// PM ruling on hitl-spec 4.2 (Test M1): with a typed answer, top-level `answer`
// is the ONLY carrier. Reply text stored alongside it must NOT resurrect a
// top-level `value` on REST or MCP, and callbacks must never send `answer: null`.

test('respond with BOTH reply text and a typed answer: no top-level value on REST nor MCP (real host, PG)', async () => {
  // Merge adaptation: a stored-schema respond cannot also carry `response`
  // (spec 7 refuses it). The PM-ruling scenario - reply text stored alongside
  // a typed answer must not resurrect a top-level value - lives on the legacy
  // no-schema path, where both carriers are accepted and read back verbatim.
  const approvalId = await askAsBot({ answerSchema: undefined })
  const typed = { kind: 'free_text', value: 'Tuesday morning ✓' }
  await decide(approvalId, { decision: 'respond', response: 'Here is some reply text', answer: typed })

  const body = await readViaRest(approvalId)
  const hitl = hitlView(body)
  assert.equal(hitl.status, 'answered')
  assert.ok(!('value' in hitl), `REST hitl view must NOT carry value alongside a typed answer, got ${JSON.stringify(hitl.value)}`)
  assert.deepEqual(hitl.answer, typed, 'REST answer must stay the only carrier, verbatim')
  const meta = hitl._meta as Record<string, unknown>
  assert.deepEqual(meta['net.hitly/answer'], hitl.answer, 'deprecated alias must still equal answer exactly')

  const got = await readViaMcp(approvalId)
  assert.equal(got.status, 'answered')
  assert.ok(!('value' in got), `MCP result must NOT carry value alongside a typed answer, got ${JSON.stringify(got.value)}`)
  assert.deepEqual(got.answer, typed, 'MCP answer must be the only carrier too')
  assert.equal(findNullAnswer(body), null, 'no answer-shaped null in the REST read')
  assert.equal(findNullAnswer(got), null, 'no answer-shaped null in the MCP result')
})

test('accept and reject with a typed answer also carry answer only, never value (real host, PG)', async () => {
  for (const decision of ['accept', 'reject'] as const) {
    // Merge adaptation: with a stored schema, a typed answer is accepted on
    // respond only (spec 7). This ruling - accept/reject carry answer, never
    // value - is exercised on the legacy no-schema path, where the generic
    // typed answer is stored verbatim on accept/reject.
    const approvalId = await askAsBot({
      answerSchema: undefined,
      actionName: 'deploy',
      args: { env: 'prod' },
      allowedActions: { accept: true, reject: true, respond: false, ignore: true },
    })
    const typed = { kind: 'free_text', value: `typed note with the ${decision}` }
    await decide(approvalId, { decision, answer: typed, reason: `reviewer rationale for ${decision}` })

    const hitl = hitlView(await readViaRest(approvalId))
    assert.equal(hitl.status, 'answered')
    assert.ok(!('value' in hitl), `REST hitl view for ${decision} + answer must omit value, got ${JSON.stringify(hitl.value)}`)
    assert.deepEqual(hitl.answer, typed)

    const got = await readViaMcp(approvalId)
    assert.ok(!('value' in got), `MCP result for ${decision} + answer must omit value, got ${JSON.stringify(got.value)}`)
    assert.deepEqual(got.answer, typed)
  }
})

test('callbacks: answered POST carries the answer intact with no null; decided POST omits answer entirely (real host, PG)', async () => {
  const hitsBefore = receiver.hits.length

  const withAnswer = await askAsBot()
  const typed = { kind: 'text', value: 'Morning' }
  await decide(withAnswer, { decision: 'respond', answer: typed })

  const answered = receiver.hits.slice(hitsBefore).filter((hit) => hit.body.type === 'answered')
  assert.equal(answered.length, 1, 'one answered callback POST must reach the receiver')
  assert.deepEqual(answered[0]!.body.answer, typed, 'answered callback must carry the answer intact')
  assert.equal(findNullAnswer(answered[0]!.body), null, 'answered callback must never carry answer: null anywhere')

  const noAnswer = await askAsBot({
    actionName: 'deploy',
    args: { env: 'prod' },
    allowedActions: { accept: true, reject: true, respond: false, ignore: true },
  })
  await decide(noAnswer, { decision: 'accept' })

  const decided = receiver.hits.slice(hitsBefore).filter((hit) => hit.body.type === 'decided')
  assert.equal(decided.length, 1, 'one decided callback POST must reach the receiver')
  assert.ok(!('answer' in decided[0]!.body), `decided callback must OMIT the answer key, got ${JSON.stringify(decided[0]!.body.answer)}`)
})
