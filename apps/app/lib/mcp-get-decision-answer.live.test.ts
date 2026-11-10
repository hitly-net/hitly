/**
 * MCP get_decision must return the human's typed ask_user answer (gate of #106).
 *
 * Real host on Postgres, no FakeHost: the ask goes in through the real ingest
 * path, a human answers through the real decideApproval, and get_decision runs
 * the real MCP tool loop over the real GET /api/v1/approvals/:id route via
 * HttpHostClient. If getApprovalForOrigin stops carrying the stored answer the
 * "answer comes back verbatim" test goes red (mutant-checked).
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { argsHash } from '@hitly/core'
import { GET as getApprovalById } from '../app/api/v1/approvals/[id]/route'
import { decideApproval } from './approvals'
import { decodeTenantJson } from './tenant-crypto'
import { redactApprovalForReviewer } from './reviewer-approval'
import { REDACTED } from './redact-request-payload'
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

async function askAsBot(body: Record<string, unknown>): Promise<string> {
  return (
    await ingestHttpAsk(fixture, receiver.url, {
      actionName: 'ask_user',
      args: {},
      kind: 'question',
      prompt: 'Which delivery slot works?',
      answerSchema: { type: 'free_text' },
      allowedActions: { accept: false, reject: false, respond: true, ignore: true },
      ...body,
    })
  ).id
}

async function readViaMcp(approvalId: string): Promise<Record<string, unknown>> {
  const h = await startHarness({
    deps: { hostFor: (key) => new HttpHostClient('https://hitly.example', key, fetchToHost) },
  })
  try {
    const mcp = await h.client(fixture.apiKey)
    const got = structured(await mcp.callTool({ name: 'get_decision', arguments: { requestId: approvalId } }))
    return { ...got, __logs: h.logs.join('\n') }
  } finally {
    await h.close()
  }
}

test('get_decision returns the typed ask_user answer verbatim through the real host (PG, no FakeHost)', async () => {
  const approvalId = await askAsBot({})
  const typed = { kind: 'text', value: 'Ship it on Tuesday before noon', confidence: 0.95 }

  const decided = await decideApproval({
    approvalId,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: { decision: 'respond', answer: typed },
  })
  assert.equal((decided as { error?: string }).error, undefined, `decide must succeed, got ${JSON.stringify(decided)}`)

  // The API-key read must carry the answer exactly as the decision payload stores it.
  const read = await getApprovalById(
    new Request(`https://hitly.example/api/v1/approvals/${approvalId}`, {
      headers: { authorization: `Bearer ${fixture.apiKey}` },
    }),
    { params: Promise.resolve({ id: approvalId }) },
  )
  assert.equal(read.status, 200)
  const body = (await read.json()) as Record<string, unknown>
  assert.deepEqual(body.answer, typed, 'host read must carry the stored answer verbatim')
  const hitl = body.hitl as { status: string; _meta?: Record<string, unknown> }
  assert.equal(hitl.status, 'answered')
  assert.deepEqual(hitl._meta?.['net.hitly/answer'], typed, 'hitl view must carry the answer under the section-12 extension key')

  // The MCP tool loop: what the bot actually sees.
  const got = await readViaMcp(approvalId)
  assert.equal(got.status, 'answered')
  assert.deepEqual(got.answer, typed, 'get_decision must return the human answer exactly as the host stores it')
  for (const secret of ['Ship it on Tuesday', 'free_text', 'confidence']) {
    assert.equal(String(got.__logs).includes(secret), false, `answer content "${secret}" must never reach the tool logs`)
  }
})

test('the answered callback carries the typed answer intact (real host leg)', async () => {
  const hitsBefore = receiver.hits.length
  const approvalId = await askAsBot({
    answerSchema: { type: 'single_choice', options: ['Morning', 'Evening'] },
  })
  const typed = { kind: 'single', value: 'Morning' }
  const decided = await decideApproval({
    approvalId,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: { decision: 'respond', answer: typed },
  })
  assert.equal((decided as { error?: string }).error, undefined)

  const answered = receiver.hits.slice(hitsBefore).filter((hit) => hit.body.type === 'answered')
  assert.equal(answered.length, 1, 'one answered callback POST must reach the receiver')
  assert.deepEqual(answered[0].body.answer, typed, 'callback payload must carry the answer intact')
})

test('get_decision returns editedArgs without touching the stored request (real host, PG)', async () => {
  const approvalId = await askAsBot({
    actionName: 'refund',
    args: { orderId: 'OR-9', amount: 42 },
    allowedActions: { accept: true, reject: true, edit: true, ignore: true },
    editableFields: { amount: { type: 'int', min: 1 } },
  })
  const [beforeRow] = await fixture.db.select({ envelope: approvals.envelope }).from(approvals).where(eq(approvals.id, approvalId))
  const originalHash = await argsHash({ orderId: 'OR-9', amount: 42 })

  const decided = await decideApproval({
    approvalId,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: { decision: 'edit', editedArgs: { amount: 25 } },
  })
  assert.equal((decided as { error?: string }).error, undefined, `edit must be accepted, got ${JSON.stringify(decided)}`)

  const got = await readViaMcp(approvalId)
  assert.equal(got.status, 'answered')
  assert.equal(got.value, 'approve')
  assert.deepEqual(got.editedArgs, { orderId: 'OR-9', amount: 25 }, 'response must carry the merged editedArgs')
  assert.equal(got.argsHash, originalHash, 'argsHash must still cover the ORIGINAL stored args')

  // Stored request unchanged: identical envelope blob after the read.
  const [afterRow] = await fixture.db.select({ envelope: approvals.envelope }).from(approvals).where(eq(approvals.id, approvalId))
  assert.deepEqual(afterRow.envelope, beforeRow.envelope, 'get_decision must never mutate the stored request')
})

test('the typed answer passes through the reviewer-facing secret redaction', async () => {
  // Secret-nested keys INSIDE answer.value are redacted (the main e1d52936
  // pin, restored) and secret-shaped SIBLING keys in the decision payload
  // are redacted by the same pass.
  const answer = { kind: 'multi', value: { contact: 'alice@example.test', api_key: 'sk-liv...CRET' } }
  const view = redactApprovalForReviewer({
    envelope: {
      action: { name: 'ask_user', args: {} },
      allowedActions: { accept: false, reject: false, edit: false, respond: true, ignore: true, cancel: false },
    },
    origin: { plugin: 'http', projectId: 'prj_redact_test', runId: 'run_redact_test', resumeHandle: { resumeUrl: 'http://127.0.0.1:1/resume' } },
    decisions: [
      {
        payload: { decision: 'respond', answer, contact: { api_key: 'sk-liv...CRET' } },
        resumeResponse: null,
      },
    ],
  })
  const payload = view.decisions[0].payload as {
    answer: { kind: string; value: Record<string, unknown> }
    contact: { api_key: string }
  }
  assert.equal(payload.answer.kind, 'multi')
  assert.equal(
    payload.answer.value.contact,
    'alice@example.test',
    'non-secret answer content survives redaction intact',
  )
  assert.equal(
    payload.answer.value.api_key,
    REDACTED,
    'secret-nested keys inside answer.value get the same redaction as other payload fields',
  )
  assert.equal(payload.contact.api_key, REDACTED, 'secret-nested keys inside the payload get the same redaction as other payload fields')
})
