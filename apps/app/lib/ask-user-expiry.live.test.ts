/**
 * LP (prod report 2026-11-10): ask_user expiry and pending lists on the real
 * host + Postgres. Mutant targets:
 * - re-adding the host-side min(envelope.expiresAt, project SLA) clamp -> the
 *   "no deadline => 24h" assertion goes red
 * - letting MCP synthesise expiresAt when the caller set no deadline -> the
 *   stored 24h and echoed-deadline assertions go red
 * - dropping the read-time settle (or the gte filter) in any pending surface
 *   -> the "expired everywhere" assertions go red
 * - firing the expiry callback outside the guarded flip -> the exactly-once
 *   callback assertion goes red
 * - hard-coding kind 'approval' or dropping prompt/question in the host list
 *   -> the list_pending item assertions go red
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { GET as getApprovalById } from '../app/api/v1/approvals/[id]/route'
import { GET as listApprovals, POST as postApproval } from '../app/api/v1/approvals/route'
import {
  cancelApprovalAsRequester,
  getApprovalForOrigin,
  listRequesterPending,
} from './approvals'
import { getApprovalDetail } from './approval-detail'
import { inboxSummary, listInboxItems } from './inbox'
import { expireOverdueApprovals } from './housekeeping/jobs'
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

function fetchToHost(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.pathname === '/api/v1/approvals' && method === 'GET') return listApprovals(new Request(input, init))
  if (url.pathname === '/api/v1/approvals' && method === 'POST') return postApproval(new Request(input, init))
  const match = /^\/api\/v1\/approvals\/([^/?#]+)$/.exec(url.pathname)
  if (match && method === 'GET') {
    return getApprovalById(new Request(input, init), { params: Promise.resolve({ id: decodeURIComponent(match[1]) }) })
  }
  return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected host call' }), { status: 404 }))
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const h = await startHarness({
    deps: { hostFor: (key) => new HttpHostClient('https://hitly.example', key, fetchToHost) },
  })
  try {
    const mcp = await h.client(fixture.apiKey)
    return structured(await mcp.callTool({ name, arguments: args }))
  } finally {
    await h.close()
  }
}

function listIds(result: Record<string, unknown>): string[] {
  return ((result.items ?? []) as Array<{ id: string }>).map((item) => item.id)
}

async function storedRow(id: string) {
  const [row] = await fixture.db
    .select({
      status: approvals.status,
      expiresAt: approvals.expiresAt,
      requesterKeyId: approvals.requesterKeyId,
      projectId: approvals.projectId,
    })
    .from(approvals)
    .where(and(eq(approvals.id, id), eq(approvals.projectId, fixture.projectId)))
  if (!row) throw new Error(`row ${id} missing`)
  return row
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('MCP ask_user and request_approval default to a stored 24h window and appear in list_pending with kind and headline (real host, PG)', async () => {
  const before = Date.now()
  const ask = await mcpCall('ask_user', {
    prompt: 'Which colour should the banner be?',
    answerSchema: { type: 'single', options: [{ value: 'blue' }, { value: 'green' }] },
    idempotencyKey: 'lp-ask-default-1',
  })
  assert.equal(ask.error, undefined, `ask_user failed: ${JSON.stringify(ask)}`)
  const askId = String(ask.requestId)

  const appr = await mcpCall('request_approval', {
    question: 'Deploy the release?',
    action: { name: 'deploy', args: { env: 'staging' } },
    idempotencyKey: 'lp-appr-default-1',
  })
  assert.equal(appr.error, undefined, `request_approval failed: ${JSON.stringify(appr)}`)
  const apprId = String(appr.requestId)

  // The host (not MCP) owns the default: no caller deadline => ~24h stored,
  // NOT the historical project-SLA clamp (60 min on prod).
  for (const id of [askId, apprId]) {
    const row = await storedRow(id)
    const windowMs = (row.expiresAt?.getTime() ?? 0) - before
    assert.ok(
      windowMs > 23.5 * 60 * 60_000 && windowMs < 24.5 * 60 * 60_000,
      `${id} must store a 24h window, got ${Math.round(windowMs / 60000)} minutes`,
    )
  }
  // The echoed deadline is the stored one, not a locally recomputed value.
  const askRow = await storedRow(askId)
  assert.equal(ask.deadline, askRow.expiresAt?.toISOString())

  // list_pending shows both, with the right kind and headline.
  const listed = await mcpCall('list_pending', { projectId: fixture.projectId })
  const items = (listed.items ?? []) as Array<Record<string, unknown>>
  const askItem = items.find((item) => item.id === askId)
  const apprItem = items.find((item) => item.id === apprId)
  assert.ok(askItem, 'ask_user must appear in list_pending')
  assert.ok(apprItem, 'request_approval must appear in list_pending')
  assert.equal(askItem?.kind, 'question')
  assert.equal(askItem?.prompt, 'Which colour should the banner be?')
  assert.equal(apprItem?.kind, 'approval')
  assert.equal(apprItem?.question, 'Deploy the release?')
  assert.equal(askItem?.status, 'pending')

  // get_decision before expiry: pending.
  const decision = await mcpCall('get_decision', { requestId: askId })
  assert.equal(decision.status, 'pending')
})

test('a short-deadline ask_user flips to expired on EVERY surface and is excluded from every pending surface (real host, PG)', async () => {
  const deadline = new Date(Date.now() + 800).toISOString()
  const ask = await mcpCall('ask_user', {
    prompt: 'Approve the refund of 42 credits?',
    answerSchema: { type: 'text' },
    idempotencyKey: 'lp-ask-short-1',
    deadline,
  })
  assert.equal(ask.error, undefined, `ask_user failed: ${JSON.stringify(ask)}`)
  const askId = String(ask.requestId)
  const kept = await mcpCall('ask_user', {
    prompt: 'Still open question?',
    answerSchema: { type: 'text' },
    idempotencyKey: 'lp-ask-keep-1',
  })
  const keptId = String(kept.requestId)

  await sleep(1200)

  // 1. Requester REST read (the origin/API-key read behind get_decision).
  const rest = await getApprovalById(
    new Request(`https://hitly.example/api/v1/approvals/${askId}`, {
      headers: { Authorization: `Bearer ${fixture.apiKey}` },
    }),
    { params: Promise.resolve({ id: askId }) },
  )
  const restBody = (await rest.json()) as Record<string, unknown>
  assert.equal(restBody.status, 'expired', 'REST origin read must report expired, never stale pending')
  assert.equal((restBody.hitl as Record<string, unknown> | undefined)?.status ?? restBody.status, 'expired')

  // 2. MCP get_decision.
  const decision = await mcpCall('get_decision', { requestId: askId })
  assert.equal(decision.status, 'expired', 'get_decision must report expired once past its deadline')

  // 3. MCP list_pending + requester list exclude it; the fresh ask stays.
  const listed = await mcpCall('list_pending', { projectId: fixture.projectId })
  assert.ok(!listIds(listed).includes(askId), 'expired ask_user must not appear in list_pending')
  assert.ok(listIds(listed).includes(keptId), 'the non-expired ask_user must still be listed')
  const requesterList = await listRequesterPending({ apiKey: fixture.apiKey, projectId: fixture.projectId })
  if (!requesterList.ok) throw new Error(`requester list failed: ${JSON.stringify(requesterList)}`)
  assert.ok(!requesterList.items.some((item) => item.id === askId))

  // 4. Web/mobile inbox open scope and the pending count.
  const inboxArgs = {
    workspaceId: fixture.workspaceId,
    userId: fixture.reviewerId,
    workspaceRole: 'member' as const,
    projectId: fixture.projectId,
  }
  const open = await listInboxItems({ ...inboxArgs, scope: 'open' })
  assert.ok(!open.items.some((item) => item.id === askId), 'the Pending/open scope must exclude expired rows')
  assert.ok(open.items.some((item) => item.id === keptId))
  const askRow = open.items.find((item) => item.id === keptId)
  assert.equal(askRow?.kind, 'question', 'inbox rows carry kind for the ask_user tag')
  assert.equal(askRow?.prompt, 'Still open question?', 'inbox rows carry the ask_user prompt for the title')
  const all = await listInboxItems({ ...inboxArgs, scope: 'all' })
  const expiredRow = all.items.find((item) => item.id === askId)
  assert.ok(expiredRow, 'closed/all scope still shows the settled row')
  assert.equal(expiredRow?.status, 'expired', 'the inbox row reads expired, not pending')
  const keptInAll = all.items.find((item) => item.id === keptId)
  assert.equal(keptInAll?.status, 'pending')
  const summary = await inboxSummary(inboxArgs)
  assert.ok(summary.pending >= 1, 'the still-open asks are counted; the expired one settled out of pending')
  assert.equal(
    (await listInboxItems({ ...inboxArgs, scope: 'open' })).items.filter((item) => item.id === askId).length,
    0,
    'the count source (open scope) must exclude expired too',
  )

  // 5. Reviewer detail: expired, no action, and NO Force cancel.
  const detail = await getApprovalDetail({
    approvalId: askId,
    userId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    workspaceRole: 'member',
  })
  if (!detail.ok) throw new Error('detail failed')
  assert.equal(detail.status, 'expired')
  assert.equal(detail.canAct, false)
  assert.equal(detail.canCancel, false, 'an expired item must not offer Force cancel')

  // 6. The DB row really flipped (no manual migration, no sweeper needed).
  const row = await storedRow(askId)
  assert.equal(row.status, 'expired')

  // 7. Requester cancel of an expired ask is refused with 409, and it stays expired.
  const cancelled = await cancelApprovalAsRequester({ apiKey: fixture.apiKey, approvalId: askId })
  assert.equal(cancelled.ok, false)
  assert.equal((cancelled as { status?: number }).status, 409)
  assert.equal((await storedRow(askId)).status, 'expired')

  // 8. The hourly sweeper must not double-report or resurrect anything.
  const swept = await expireOverdueApprovals()
  assert.equal(typeof swept.expired, 'number')
  assert.equal((await storedRow(askId)).status, 'expired')
})

test('a past-deadline row created directly in the DB (prod backfill case) reads expired without any sweeper run (real host, PG)', async () => {
  const created = await ingestHttpAsk(fixture, receiver.url, { actionName: 'ask_user', prompt: 'Legacy ask?' })
  const legacyId = created.id
  // Backdate it like the four prod rows, leaving status pending.
  await fixture.db
    .update(approvals)
    .set({ expiresAt: new Date(Date.now() - 70 * 60_000) })
    .where(eq(approvals.id, legacyId))

  const origin = await getApprovalForOrigin({ apiKey: fixture.apiKey, approvalId: legacyId })
  assert.ok(origin.ok)
  assert.equal(origin.status, 'expired', 'an already-expired pending row must read expired on first sight')

  const listed = await listRequesterPending({ apiKey: fixture.apiKey, projectId: fixture.projectId })
  if (!listed.ok) throw new Error('requester list failed')
  assert.ok(!listed.items.some((item) => item.id === legacyId))
})

test('the expiry callback fires exactly once even when several read surfaces settle the same row (real host, PG)', async () => {
  const before = receiver.hits.length
  const created = await ingestHttpAsk(fixture, receiver.url, {
    actionName: 'ask_user',
    prompt: 'Expired with callback?',
    expiresAt: new Date(Date.now() + 300).toISOString(),
    lifecycleEvents: ['expired'],
  })
  const id = created.id
  await sleep(600)

  // Hit every read surface that settles rows, plus the sweeper backstop.
  await getApprovalForOrigin({ apiKey: fixture.apiKey, approvalId: id })
  await listRequesterPending({ apiKey: fixture.apiKey, projectId: fixture.projectId })
  await listInboxItems({
    workspaceId: fixture.workspaceId,
    userId: fixture.reviewerId,
    workspaceRole: 'member',
    projectId: fixture.projectId,
    scope: 'open',
  })
  await inboxSummary({
    workspaceId: fixture.workspaceId,
    userId: fixture.reviewerId,
    workspaceRole: 'member',
    projectId: fixture.projectId,
  })
  await expireOverdueApprovals()

  const expiryHits = receiver.hits.slice(before).filter((hit) => hit.body.type === 'expired')
  assert.equal(expiryHits.length, 1, `the expired callback must fire exactly once, got ${expiryHits.length}`)
  assert.ok(expiryHits[0]?.headers?.['x-hitly-event-id'], 'the expiry callback carries a stable event id for receiver dedupe')
})
