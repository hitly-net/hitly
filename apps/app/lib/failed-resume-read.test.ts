/**
 * A human decision must survive a failed resume on every requester read.
 *
 * When a reviewer ACCEPTS (or rejects, or answers) and the resume callback
 * then fails, the approval lands in `failed_resume`. That is a delivery
 * problem, not a human one: the recorded outcome must still read back as the
 * human's decision, with the resume failure surfaced separately as
 * `callbackDelivery: 'failed'` - never as `declined`.
 *
 * Pins (real host on Postgres, real GET route, real MCP get_decision loop):
 * - failed_resume after accept  -> answered, value "approve", callbackDelivery "failed";
 * - failed_resume after reject  -> answered, value "reject" (REST; hitl-spec
 *   reject is an answered outcome with value "reject", not a decline),
 *   callbackDelivery "failed";
 * - failed_resume after a typed ask_user answer -> answered with the answer
 *   verbatim (the ONLY carrier, no top-level value), callbackDelivery "failed";
 * - the no-callback reads added by fix/no-callback-no-resume are unchanged:
 *   decided without a stored resumeUrl keeps callbackDelivery "none" and no
 *   failed_resume is ever reported.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { GET as getApprovalById } from '../app/api/v1/approvals/[id]/route'
import { decideApproval } from './approvals'
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

async function decide(approvalId: string, payload: Parameters<typeof decideApproval>[0]['payload']) {
  const decided = await decideApproval({
    approvalId,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload,
  })
  assert.equal((decided as { error?: string }).error, undefined, `decide must succeed, got ${JSON.stringify(decided)}`)
  return decided as { status?: string }
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

/** Ingest a http ask whose resume receiver answers 500, decide it, assert it landed in failed_resume. */
async function decideWithFailedResume(payload: Parameters<typeof decideApproval>[0]['payload']): Promise<string> {
  receiver.setMode('fail')
  const { id } = await ingestHttpAsk(fixture, receiver.url)
  const decided = await decide(id, payload)
  assert.equal(decided.status, 'failed_resume', 'a dead receiver must land the approval in failed_resume')
  return id
}

function hitlView(body: Record<string, unknown>): Record<string, unknown> {
  assert.ok(body.hitl && typeof body.hitl === 'object', 'hitl view must exist once a human has decided')
  return body.hitl as Record<string, unknown>
}

test('failed_resume after a human accept reads answered/approve with the delivery failure separate (real host, PG)', async () => {
  const id = await decideWithFailedResume({ decision: 'accept' })

  const rest = await readViaRest(id)
  assert.equal(rest.status, 'failed_resume', 'raw status stays failed_resume for operator surfaces')
  const hitl = hitlView(rest)
  assert.equal(hitl.status, 'answered', 'a human accept must never read as declined')
  assert.equal(hitl.value, 'approve')
  assert.notEqual(hitl.status, 'declined')

  const mcp = await readViaMcp(id)
  assert.equal(mcp.status, 'answered', 'MCP get_decision must never report a failed delivery as declined')
  assert.equal(mcp.value, 'approve')
  assert.equal(mcp.callbackDelivery, 'failed', 'the resume failure is surfaced as a delivery outcome')
})

test('failed_resume after a human reject reads the recorded reject outcome, not a delivery-fabricated decline (real host, PG)', async () => {
  const id = await decideWithFailedResume({ decision: 'reject', reason: 'Not this one' })

  const rest = await readViaRest(id)
  const hitl = hitlView(rest)
  assert.equal(hitl.status, 'answered', 'reject is an answered outcome with value "reject" (hitl-spec 4)')
  assert.equal(hitl.value, 'reject')

  const mcp = await readViaMcp(id)
  assert.equal(mcp.status, 'answered')
  assert.equal(mcp.value, 'reject', 'the recorded reject must come back as reject, never as a decline')
  assert.equal(mcp.callbackDelivery, 'failed')
})

test('failed_resume after a typed ask_user answer reads answered with the answer verbatim (real host, PG)', async () => {
  const typed = { kind: 'single_choice', value: 'Hall B', note: { confidence: 0.9 } }
  receiver.setMode('fail')
  const { id } = await ingestHttpAsk(fixture, receiver.url, {
    actionName: 'ask_user',
    args: {},
    kind: 'question',
    prompt: 'Which hall?',
    answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
    allowedActions: { accept: false, reject: false, respond: true, ignore: true },
  })
  const decided = await decide(id, { decision: 'respond', response: 'Hall B', answer: typed })
  assert.equal(decided.status, 'failed_resume', 'a dead receiver must land the ask in failed_resume')

  const rest = await readViaRest(id)
  const hitl = hitlView(rest)
  assert.equal(hitl.status, 'answered', 'a human answer must never read as declined because delivery failed')
  assert.deepEqual(hitl.answer, typed, 'the typed answer is returned verbatim')
  assert.equal(hitl.value, undefined, 'the typed answer is the ONLY carrier (hitl-spec 4.2)')

  const mcp = await readViaMcp(id)
  assert.equal(mcp.status, 'answered')
  assert.deepEqual(mcp.answer, typed, 'MCP get_decision returns the answer exactly as stored')
  assert.equal(mcp.value, undefined)
  assert.equal(mcp.callbackDelivery, 'failed')
})

test('a decided request without callback_url still reads callbackDelivery none (no-callback behaviour unchanged, real host, PG)', async () => {
  // No resumeUrl at create time => zero outbound attempts, status decided.
  // Fresh receiver: this test asserts ZERO hits, so it must not share the
  // counter with the resume tests above.
  const quiet = await startCapturingReceiver()
  try {
    const { id } = await ingestHttpAsk(fixture, quiet.url, { resumeUrl: undefined })
    const decided = await decide(id, { decision: 'accept' })
    assert.equal(decided.status, 'decided', 'without a stored resumeUrl HITLy never attempts a resume')
    assert.equal(quiet.hits.length, 0, 'no callback attempt at all')

    const rest = await readViaRest(id)
    assert.equal(rest.callbackDelivery, 'none')

    const mcp = await readViaMcp(id)
    assert.equal(mcp.status, 'answered')
    assert.equal(mcp.value, 'approve')
    assert.equal(mcp.callbackDelivery, 'none', 'no-callback reads stay none, never failed')
  } finally {
    await quiet.close()
  }
})
