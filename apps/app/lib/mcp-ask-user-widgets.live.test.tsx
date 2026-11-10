/**
 * WIDGETS e2e (hitl/v0 typed ask_user, one request per field), end to end
 * with NO FakeHost anywhere:
 *
 *   real MCP ask_user tool  ->  real POST /api/v1/approvals ingest  ->  real
 *   Postgres envelope (answerSchema + prompt persisted, spec type stored)  ->
 *   the inbox widget rendered from the STORED schema  ->  the exact FormData
 *   payload the web form submits  ->  real decideApproval  ->  real MCP
 *   get_decision returns `status: answered` + `answer: {kind, value}`  ->
 *   the callback sink receives `type: answered` with the same answer.
 *
 * A `simple_form` ask_user is refused with the one-request-per-field message,
 * and a replayed idempotency key whose answerSchema differs is a 409, not a
 * silent replay (create-once covers the stored schema).
 *
 * Env-guarded: without DATABASE_URL + HITLY_ENCRYPTION_KEK every test skips
 * (the real TEST host is not reachable from the dev box; CI provides this
 * env, and locally run it against a disposable Postgres, never prod):
 *   DATABASE_URL=... HITLY_ENCRYPTION_KEK=... pnpm --filter @hitly/app test
 *
 * The callback leg delivers through the documented destination-check test
 * seam (see otel-trace.test.ts): resolution and transport are faked to the
 * local capturing receiver, everything else is the real delivery path.
 */
import 'global-jsdom/register'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { setDestinationCheckTestHooks, globalFetchTransport } from '@hitly/core/destination-check'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { POST as postIngest } from '../app/api/v1/approvals/route'
import { GET as getApprovalById } from '../app/api/v1/approvals/[id]/route'
import { decideApproval, parseDecisionBody } from './approvals'
import { decodeTenantJson } from './tenant-crypto'
import { parseAnswerField } from './answer-form-helpers'
import { AnswerSection } from '../components/answer-section'
import type { AnswerSchema } from '@hitly/core'
import {
  closeM0hFixture,
  createM0hFixture,
  startCapturingReceiver,
  type CapturingReceiver,
  type M0hFixture,
} from './m0h-fixture'
import { HttpHostClient } from '../../mcp/src/host-client.ts'
import { startHarness, structured } from '../../mcp/src/test-helpers.ts'

const READY = Boolean(process.env.DATABASE_URL && process.env.HITLY_ENCRYPTION_KEK)
const SKIP = READY ? false : 'requires DATABASE_URL + HITLY_ENCRYPTION_KEK (real-host e2e env)'

// jsdom's HTMLFormElement needs jsdom's FormData, not node's undici global.
globalThis.FormData = window.FormData

let fixture: M0hFixture
let receiver: CapturingReceiver
let realFetch: typeof globalThis.fetch

before(async () => {
  if (!READY) return
  fixture = await createM0hFixture()
  receiver = await startCapturingReceiver()
  // Callback delivery: keep the real checkedFetch policy path but resolve and
  // transport to the local capturing receiver (https callback_url is required
  // by the MCP tool; the sink speaks plain http).
  realFetch = globalThis.fetch
  const cbPrefix = `https://127.0.0.1:${receiver.port}/`
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(cbPrefix)) return realFetch(url.replace(/^https:/, 'http:'), init)
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch
  setDestinationCheckTestHooks({ resolve: async () => [{ address: '127.0.0.1' }], transport: globalFetchTransport })
})

after(async () => {
  if (!READY) return
  setDestinationCheckTestHooks()
  if (realFetch) globalThis.fetch = realFetch
  cleanup()
  await receiver?.close()
  if (fixture) await closeM0hFixture(fixture)
})

/** Route MCP host calls to the real Next route handlers (no network). */
function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.pathname === '/api/v1/approvals' && method === 'POST') {
    return postIngest(new Request(input as RequestInfo, init))
  }
  const match = /^\/api\/v1\/approvals\/([^/?#]+)$/.exec(url.pathname)
  if (match && method === 'GET') {
    return getApprovalById(new Request(input as RequestInfo, init), {
      params: Promise.resolve({ id: decodeURIComponent(match[1]) }),
    })
  }
  return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected host call' }), { status: 404 }))
}

async function withMcp<T>(fn: (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const h = await startHarness({
    env: { HITLY_MCP_PUBLIC_URL: 'https://hitly.example' },
    deps: { hostFor: (key) => new HttpHostClient('https://hitly.example', key, hostFetch) },
  })
  try {
    const client = await h.client(fixture.apiKey)
    return await fn(async (name, args) => structured(await client.callTool({ name, arguments: args })))
  } finally {
    await h.close()
  }
}

async function storedEnvelope(approvalId: string): Promise<Record<string, unknown>> {
  const [row] = await fixture.db
    .select({ envelope: approvals.envelope })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
  return (await decodeTenantJson(fixture.workspaceId, row!.envelope)) as Record<string, unknown>
}

/** Render the inbox respond controls from the STORED schema and submit them. */
function submitWidget(schema: AnswerSchema, pick: unknown): FormData {
  let submitted: FormData | null = null
  const view = render(
    <form onSubmit={(event) => {
      event.preventDefault()
      submitted = new FormData(event.currentTarget)
    }}>
      <AnswerSection respondAllowed={true} answerSchema={schema} value={pick} onChange={() => undefined} />
      <button name="decision" value="respond">respond</button>
    </form>,
  )
  fireEvent.submit(view.container.querySelector('form')!)
  cleanup()
  if (!submitted) throw new Error('widget form did not submit')
  return submitted
}

test('e2e: MCP text ask -> stored schema -> widget -> web decide -> get_decision answered -> sink', { skip: SKIP }, async () => {
  const hitsBefore = receiver.hits.length
  const asked = await withMcp(async (call) =>
    call('ask_user', {
      idempotencyKey: `widgets-e2e-text-${Date.now()}`,
      prompt: 'Ship on Tuesday?',
      callback_url: `https://127.0.0.1:${receiver.port}/resume`,
      answerSchema: { type: 'free_text' },
    }),
  )
  assert.equal(asked.state, 'pending')
  const id = String(asked.requestId)
  assert.match(id, /^apr_/)

  // (2) host detail loader sees the persisted schema, spec name, and prompt.
  const envelope = await storedEnvelope(id)
  assert.equal(envelope.prompt, 'Ship on Tuesday?')
  const schema = envelope.answerSchema as AnswerSchema
  assert.equal(schema.type, 'text', 'the stored type is the spec name, not the free_text alias')

  // (3) the inbox renders the text widget, not an anonymous Response box.
  let submitted: FormData | null = null
  const view = render(
    <form onSubmit={(event) => {
      event.preventDefault()
      submitted = new FormData(event.currentTarget)
    }}>
      {/* the real form carries the decision on the clicked button; jsdom's
          FormData(form) has no submitter, so a hidden field plays that role */}
      <input type="hidden" name="decision" value="respond" />
      <AnswerSection respondAllowed={true} answerSchema={schema} value="Ship on Tuesday" onChange={() => undefined} />
      <button type="submit">respond</button>
    </form>,
  )
  const widget = view.container.querySelector('input[name="answer_text"]') as HTMLInputElement | null
  assert.ok(widget, 'text widget rendered from the stored schema')
  assert.equal(widget.getAttribute('data-answer-type'), 'text')
  assert.equal(view.container.querySelector('input[name="response"]'), null, 'no legacy Response box with a stored schema')
  assert.equal(view.container.querySelectorAll('input:not([type="hidden"]), textarea, select').length, 1, 'exactly one field: no form')
  assert.equal(widget.value, 'Ship on Tuesday', 'the reviewer keeps their input (spec 7)')
  fireEvent.submit(view.container.querySelector('form')!)
  cleanup()
  assert.ok(submitted, 'form submitted')

  // (4) decide with the EXACT payload the web form posted.
  const parsed = parseAnswerField(submitted!.get('answer') as string | null)
  assert.equal(parsed.ok, true)
  const payload = parseDecisionBody({
    decision: String(submitted!.get('decision')),
    answer: parsed.ok ? parsed.answer : undefined,
  })
  assert.ok(payload, 'the submitted payload parses as a valid decision')
  const decided = await decideApproval({
    approvalId: id,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: payload as never,
  })
  assert.equal((decided as { error?: string }).error, undefined)
  assert.equal((decided as { status?: string }).status, 'decided')

  // (5) MCP get_decision: answered with the typed answer verbatim.
  const got = await withMcp((call) => call('get_decision', { requestId: id }))
  assert.equal(got.status, 'answered')
  assert.deepEqual(got.answer, { kind: 'text', value: 'Ship on Tuesday' })

  // (6) the callback sink received answered with the same answer.
  const answered = receiver.hits.slice(hitsBefore).filter((hit) => hit.body.type === 'answered')
  assert.equal(answered.length, 1, 'exactly one answered callback')
  assert.equal(answered[0]!.body.state, 'answered')
  assert.deepEqual(answered[0]!.body.answer, { kind: 'text', value: 'Ship on Tuesday' })
})

test('e2e: MCP single_choice ask stores spec kind single and the radio pick round-trips', { skip: SKIP }, async () => {
  const asked = await withMcp((call) =>
    call('ask_user', {
      idempotencyKey: `widgets-e2e-single-${Date.now()}`,
      prompt: 'Which venue?',
      callback_url: `https://127.0.0.1:${receiver.port}/resume`,
      answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
    }),
  )
  const id = String(asked.requestId)
  const schema = (await storedEnvelope(id)).answerSchema as AnswerSchema
  assert.equal(schema.type, 'single')
  assert.deepEqual(schema.options, [
    { value: 'Hall A', label: 'Hall A' },
    { value: 'Hall B', label: 'Hall B' },
  ], 'string options normalised to {value,label}')

  // Widget assertion: radios for the stored options, not a Response box.
  const view = render(<AnswerSection respondAllowed={true} answerSchema={schema} value="Hall B" onChange={() => undefined} />)
  const radios = Array.from(view.container.querySelectorAll('input[type="radio"]'))
  assert.equal(radios.length, 2)
  assert.equal(view.container.querySelector('input[name="response"]'), null)
  cleanup()

  // The exact FormData the form produces, submitted through the host.
  const submitted = submitWidget(schema, 'Hall B')
  const parsed = parseAnswerField(submitted.get('answer') as string | null)
  assert.equal(parsed.ok, true)
  const decided = await decideApproval({
    approvalId: id,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: parseDecisionBody({ decision: 'respond', answer: parsed.ok ? parsed.answer : undefined }) as never,
  })
  assert.equal((decided as { error?: string }).error, undefined)

  const got = await withMcp((call) => call('get_decision', { requestId: id }))
  assert.equal(got.status, 'answered')
  assert.deepEqual(got.answer, { kind: 'single', value: 'Hall B' }, 'answer kind is the spec name')
})

test('e2e: MCP number ask stores bounds, the widget honours them, off-step is refused, in-bounds answers round-trip', { skip: SKIP }, async () => {
  const hitsBefore = receiver.hits.length
  const asked = await withMcp((call) =>
    call('ask_user', {
      idempotencyKey: `widgets-e2e-number-${Date.now()}`,
      prompt: 'How many units?',
      callback_url: `https://127.0.0.1:${receiver.port}/resume`,
      answerSchema: { type: 'number', bounds: { min: 0, max: 10, step: 2, unit: 'kg' } },
    }),
  )
  const id = String(asked.requestId)
  const schema = (await storedEnvelope(id)).answerSchema as AnswerSchema
  assert.equal(schema.type, 'number')
  assert.deepEqual(schema.bounds, { min: 0, max: 10, step: 2, unit: 'kg' }, 'bounds persist verbatim')

  // Widget renders a number input honouring the stored bounds.
  const view = render(<AnswerSection respondAllowed={true} answerSchema={schema} value={4} onChange={() => undefined} />)
  const input = view.container.querySelector('input[type="number"]') as HTMLInputElement | null
  assert.ok(input, 'number widget rendered')
  assert.equal(input.getAttribute('data-answer-type'), 'number')
  assert.equal(input.getAttribute('min'), '0')
  assert.equal(input.getAttribute('max'), '10')
  assert.equal(input.getAttribute('step'), '2')
  assert.equal(view.container.querySelector('input[name="response"]'), null, 'no legacy Response box')
  cleanup()

  // Off-step (3.5) is refused by the HOST, not silently accepted.
  const offStep = await decideApproval({
    approvalId: id,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: parseDecisionBody({ decision: 'respond', answer: { kind: 'number', value: 3.5 } }) as never,
  })
  assert.equal((offStep as { status?: number }).status, 400, 'a value off the stored step is refused')

  // In-bounds pick through the form widget decides and round-trips.
  const submitted = submitWidget(schema, 4)
  const parsed = parseAnswerField(submitted.get('answer') as string | null)
  assert.equal(parsed.ok, true)
  const decided = await decideApproval({
    approvalId: id,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: parseDecisionBody({ decision: 'respond', answer: parsed.ok ? parsed.answer : undefined }) as never,
  })
  assert.equal((decided as { error?: string }).error, undefined, `decide must succeed, got ${JSON.stringify(decided)}`)

  const got = await withMcp((call) => call('get_decision', { requestId: id }))
  assert.equal(got.status, 'answered')
  assert.deepEqual(got.answer, { kind: 'number', value: 4 })

  const answered = receiver.hits.slice(hitsBefore).filter((hit) => hit.body.type === 'answered')
  assert.equal(answered.length, 1, 'exactly one answered callback')
  assert.deepEqual(answered[0]!.body.answer, { kind: 'number', value: 4 })
})

test('e2e: simple_form is refused with the one-request-per-field message', { skip: SKIP }, async () => {
  const refused = await withMcp((call) =>
    call('ask_user', {
      idempotencyKey: `widgets-e2e-form-${Date.now()}`,
      prompt: 'Publish the post?',
      answerSchema: {
        type: 'simple_form',
        fields: [
          { name: 'headline', label: 'Headline' },
          { name: 'post_date', label: 'Post date (YYYY-MM-DD)' },
          { name: 'notes', label: 'Notes' },
        ],
      },
    }),
  )
  const error = refused.error as { code?: string; message?: string }
  assert.equal(error.code, 'invalid_request')
  assert.match(String(error.message), /one request per field/)
  assert.match(String(error.message), /separate ask_user/)
})

test('e2e: same idempotency key, different answerSchema -> 409 idempotency_conflict (never silent replay)', { skip: SKIP }, async () => {
  const key = `widgets-e2e-once-${Date.now()}`
  const base = {
    idempotencyKey: key,
    prompt: 'Approve the amount?',
    callback_url: `https://127.0.0.1:${receiver.port}/resume`,
  }
  const first = await withMcp((call) => call('ask_user', { ...base, answerSchema: { type: 'text' } }))
  assert.equal(first.state, 'pending')
  const replay = await withMcp((call) =>
    call('ask_user', { ...base, answerSchema: { type: 'single', options: ['yes', 'no'] } }),
  )
  const error = replay.error as { code?: string; message?: string }
  // The host answers 409 idempotency_conflict; the MCP host client maps any
  // 4xx to invalid_request with the host's own message verbatim.
  assert.equal(error.code, 'invalid_request')
  assert.match(String(error.message), /Idempotency-Key reused with a different payload/, 'a changed answerSchema under the same key is a conflict')
})
