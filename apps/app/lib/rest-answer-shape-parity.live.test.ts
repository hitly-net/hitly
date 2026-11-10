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
 * (4) removing the top-level answer from the hitl view (old REST nesting).
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
const TYPED_VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['unicode', { kind: 'free_text', value: 'Übermorgen um 13:00 ✓ 日本語 🚀', note: 'ünïcode' }],
  ['multiline', { kind: 'free_text', value: 'line one\nline two\r\nline three\n', confidence: 0.5 }],
  ['empty string', { kind: 'free_text', value: '' }],
  ['long', { kind: 'free_text', value: 'ünïcode 🚀 long answer '.repeat(2_000) }],
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
  await decide(approvalId, { decision: 'respond', answer: { kind: 'free_text', value: 'No reply text needed' } })

  const body = await readViaRest(approvalId)
  const hitl = hitlView(body)
  assert.equal(hitl.status, 'answered')
  assert.ok(!('value' in hitl), `REST hitl view must OMIT value when the reviewer sent no reply text, got ${JSON.stringify(hitl.value)}`)

  const got = await readViaMcp(approvalId)
  assert.equal(got.status, 'answered')
  assert.ok(!('value' in got), `MCP result must OMIT value when the reviewer sent no reply text, got ${JSON.stringify(got.value)}`)
})

test('respond with an explicit empty-string reply keeps value: "" on both surfaces (real host, PG)', async () => {
  const approvalId = await askAsBot()
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
  const approvalId = await askAsBot()
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
  const approvalId = await askAsBot()
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
