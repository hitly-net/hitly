/**
 * Pending surfaces on the real host (Postgres): a request a human has
 * already decided whose resume then failed (`failed_resume`) must disappear
 * from EVERY pending list and count, while its delivery failure stays
 * readable on the operator/requester surfaces.
 *
 * Same style as mcp-list-pending.live.test.ts / failed-resume-read.test.ts:
 * real GET routes, real MCP harness, real pg. Mutant targets:
 * - re-adding failed_resume to listRequesterPending's filter -> MCP assertion red
 * - re-adding failed_resume to the inbox 'open' scope -> web/mobile assertions red
 * - counting failed_resume in inboxSummary -> pending-count assertion red
 * - letting the exclusion leak into get_decision / raw status -> last assertions red
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { GET as getApprovalById } from '../app/api/v1/approvals/[id]/route'
import { GET as listApprovals } from '../app/api/v1/approvals/route'
import { decideApproval, listRequesterPending } from './approvals'
import { inboxSummary, listInboxItems } from './inbox'
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
let decidedFailedId = ''
let stillPendingId = ''

before(async () => {
  fixture = await createM0hFixture()
  receiver = await startCapturingReceiver()
  receiver.setMode('fail')
  const failed = await ingestHttpAsk(fixture, receiver.url, { actionName: 'm0h-already-decided' })
  const pending = await ingestHttpAsk(fixture, receiver.url, { actionName: 'm0h-awaiting' })
  decidedFailedId = failed.id
  stillPendingId = pending.id
  const decided = await decideApproval({
    approvalId: failed.id,
    actorUserId: fixture.reviewerId,
    workspaceId: fixture.workspaceId,
    payload: { decision: 'accept' },
  })
  assert.equal((decided as { error?: string }).error, undefined, `decide must succeed, got ${JSON.stringify(decided)}`)
  assert.equal((decided as { status?: string }).status, 'failed_resume', 'a dead receiver must land the approval in failed_resume')
})

after(async () => {
  await receiver?.close()
  if (fixture) await closeM0hFixture(fixture)
})

function fetchToHost(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input)
  if (url.pathname === '/api/v1/approvals' && (init?.method ?? 'GET').toUpperCase() === 'GET') {
    return listApprovals(new Request(input, init))
  }
  const match = /^\/api\/v1\/approvals\/([^/?#]+)$/.exec(url.pathname)
  if (match && (init?.method ?? 'GET').toUpperCase() === 'GET') {
    return getApprovalById(new Request(input, init), { params: Promise.resolve({ id: decodeURIComponent(match[1]) }) })
  }
  return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected host call' }), { status: 404 }))
}

function mcpCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (async () => {
    const h = await startHarness({
      deps: { hostFor: (key) => new HttpHostClient('https://hitly.example', key, fetchToHost) },
    })
    try {
      const mcp = await h.client(fixture.apiKey)
      return structured(await mcp.callTool({ name, arguments: args }))
    } finally {
      await h.close()
    }
  })()
}

test('a human-decided failed_resume row is excluded from every pending surface, still readable as failed (real host, PG)', async () => {
  // The row really is failed_resume in the database (operator REST below and
  // get_decision keep their behaviour; only pending surfaces change).
  const [row] = await fixture.db
    .select({ status: approvals.status })
    .from(approvals)
    .where(eq(approvals.id, decidedFailedId))
  assert.equal(row?.status, 'failed_resume', 'operator REST status must still read failed_resume')

  // 1. MCP list_pending (via the real host GET /api/v1/approvals?status=pending).
  const listed = await mcpCall('list_pending', { projectId: fixture.projectId })
  const items = (listed.items ?? []) as Array<{ id: string }>
  const ids = items.map((item) => item.id)
  assert.ok(ids.includes(stillPendingId), `an awaiting item must still be listed, got ${ids.join(',')}`)
  assert.ok(!ids.includes(decidedFailedId), 'failed_resume must not appear in MCP list_pending')

  // 2. Requester list (the host side of the same call).
  const requesterList = await listRequesterPending({ apiKey: fixture.apiKey, projectId: fixture.projectId })
  if (!requesterList.ok) throw new Error(`requester list failed: ${JSON.stringify(requesterList)}`)
  assert.ok(requesterList.items.some((item) => item.id === stillPendingId))
  assert.ok(!requesterList.items.some((item) => item.id === decidedFailedId), 'failed_resume must not appear in the host pending list')

  // 3. Web + mobile pending inbox (shared listInboxItems, scope=open).
  const inboxArgs = {
    workspaceId: fixture.workspaceId,
    userId: fixture.reviewerId,
    workspaceRole: 'member' as const,
    projectId: fixture.projectId,
    scope: 'open',
  }
  const inbox = await listInboxItems(inboxArgs)
  assert.ok(inbox.items.some((item) => item.id === stillPendingId), 'web/mobile pending list must include awaiting items')
  assert.ok(!inbox.items.some((item) => item.id === decidedFailedId), 'web/mobile pending list must exclude failed_resume')

  // 4. Pending count (web home card, web favicon badge, mobile alert badge).
  const summary = await inboxSummary({
    workspaceId: fixture.workspaceId,
    userId: fixture.reviewerId,
    workspaceRole: 'member' as const,
    projectId: fixture.projectId,
  })
  assert.equal(summary.pending, 1, 'pending count must exclude the already-decided failed_resume row')
  assert.equal(summary.failedResume, 1, 'the failed-resume count stays available for operator surfaces')

  // 5. get_decision still reports the failed delivery for the decided row.
  const decision = await mcpCall('get_decision', { requestId: decidedFailedId })
  assert.equal(decision.status, 'answered', 'a human accept must read answered, never declined')
  assert.equal(decision.value, 'approve')
  assert.equal(decision.callbackDelivery, 'failed', 'the resume failure stays visible via get_decision')

  // 6. Operator REST read still exposes the raw failed_resume status.
  const rest = await getApprovalById(
    new Request(`https://hitly.example/api/v1/approvals/${decidedFailedId}`, {
      headers: { 'Authorization': `Bearer ${fixture.apiKey}` },
    }),
    { params: Promise.resolve({ id: decidedFailedId }) },
  )
  assert.equal(rest.status, 200)
  const body = (await rest.json()) as Record<string, unknown>
  assert.equal(body.status, 'failed_resume', 'operator REST status must still show failed_resume')
})
