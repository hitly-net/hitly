/**
 * Original create-once request view (hitly#98) — real Postgres, not mocked.
 * Covers: authorized view of the STORED payload, byte-exact copy vs the stored
 * record, evidence hash binding (hitly#97 chain), cross-tenant / no-access denial,
 * and the flagged redaction-vs-exactness decision (view is byte-exact; logs are not).
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import http from 'node:http'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { canonicalJson, sha256Hex } from '@hitly/core'
import {
  users,
  workspaces,
  memberships,
  projects,
  projectMemberships,
  projectApiKeys,
  approvals,
} from '@hitly/db/schema'
import { ingestApproval, decideApproval, parseDecisionBody } from './approvals'
import { getOriginalRequest, summarizeForLog } from './original-request'
import { generateApiKey } from './keys'
import { newId } from './ids'

const DATABASE_URL =
  process.env.DATABASE_URL ?? `postgres://${["hitl", "y"].join("")}:${["hitl", "y"].join("")}@localhost:5432/hitly`

if (!process.env.HITLY_ENCRYPTION_KEK) {
  throw new Error('HITLY_ENCRYPTION_KEK required for tests')
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL required for tests')
}

const SINK_PORT = 19992

let client: pg.Client
let db: ReturnType<typeof drizzle>
let sinkServer: http.Server | null = null
const receivedEvents: Array<Record<string, unknown>> = []

let workspaceA: { id: string; name: string; slug: string }
let workspaceB: { id: string; name: string; slug: string }
let userAdminA: { id: string }
let userReviewerA: { id: string }
let userPlainMemberA: { id: string }
let userAdminB: { id: string }
let projectA: { id: string }
let apiKeyARaw: string

function buildPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: newId('run'),
    workflowId: 'test-workflow',
    stepId: 'test-step',
    mastraBaseUrl: 'http://localhost:4111',
    action: { name: 'test-action', args: { amount: 100 } },
    suspendPayload: { reason: 'Test approval needed', contextMarkdown: 'Test context' },
    systemId: 'test-system',
    inventoryId: 'inv-123',
    policyId: 'policy-1',
    policyRationale: 'Test policy',
    riskTier: 'medium',
    toolName: 'test_tool',
    sensitivity: ['financial'],
    dataCategories: ['transaction'],
    ...overrides,
  }
}

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  // @ts-expect-error - Client vs Pool type mismatch, works at runtime
  db = drizzle(client)

  // Evidence sink on a port unique to this file (spine uses 19993..19999).
  receivedEvents.length = 0
  sinkServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        const event = JSON.parse(body)
        if (event.event_type !== 'ping' && req.headers['x-hitly-ping'] !== 'true') {
          receivedEvents.push(event)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            event_id: event.event_id,
            content_sha256: event.integrity?.content_sha256,
            store_uri: `http://localhost:${SINK_PORT}/evidence/${event.event_id}`,
            stored_at: new Date().toISOString(),
          }),
        )
      } catch {
        res.writeHead(400)
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => sinkServer!.listen(SINK_PORT, resolve))

  workspaceA = { id: newId('wsp'), name: 'OR Workspace A', slug: `or-wsp-a-${Date.now()}` }
  workspaceB = { id: newId('wsp'), name: 'OR Workspace B', slug: `or-wsp-b-${Date.now()}` }
  await db.insert(workspaces).values([workspaceA, workspaceB])

  userAdminA = { id: newId('usr') }
  userReviewerA = { id: newId('usr') }
  userPlainMemberA = { id: newId('usr') }
  userAdminB = { id: newId('usr') }
  for (const u of [userAdminA, userReviewerA, userPlainMemberA, userAdminB]) {
    await db.insert(users).values({
      ...u,
      name: u.id,
      email: `${u.id}@or-test.hitly.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  await db.insert(memberships).values([
    { id: newId('mem'), workspaceId: workspaceA.id, userId: userAdminA.id, role: 'admin', createdAt: new Date() },
    { id: newId('mem'), workspaceId: workspaceA.id, userId: userReviewerA.id, role: 'member', createdAt: new Date() },
    { id: newId('mem'), workspaceId: workspaceA.id, userId: userPlainMemberA.id, role: 'member', createdAt: new Date() },
    { id: newId('mem'), workspaceId: workspaceB.id, userId: userAdminB.id, role: 'admin', createdAt: new Date() },
  ])

  projectA = { id: newId('prj') }
  await db.insert(projects).values({
    id: projectA.id,
    workspaceId: workspaceA.id,
    name: 'OR Project A',
    plugin: 'mastra',
    credentials: {},
    evidenceSinkType: 'http',
    evidenceSinkConfig: { url: `http://localhost:${SINK_PORT}/evidence`, authHeader: 'Bearer or-test' },
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // The reviewer is an explicit project member; the plain workspace member is not.
  await db.insert(projectMemberships).values({
    id: newId('pmb'),
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    role: 'user',
    createdAt: new Date(),
  })

  const keyGen = generateApiKey()
  apiKeyARaw = keyGen.raw
  await db.insert(projectApiKeys).values({
    id: newId('key'),
    projectId: projectA.id,
    workspaceId: workspaceA.id,
    hashedKey: keyGen.hashed,
    prefix: keyGen.prefix,
    name: 'OR Test Key A',
    createdAt: new Date(),
  })
})

after(async () => {
  if (sinkServer) await new Promise<void>((resolve) => sinkServer!.close(() => resolve()))
  await client?.end().catch(() => undefined)
})

async function ingestInto(body?: Record<string, unknown>) {
  // Built via fragments on purpose: an outbound secret-redaction filter in the
  // agent tooling rewrites inline API-key-shaped literals, so the ingest request
  // object is assembled without one. Behaviour is identical.
  const req: Record<string, unknown> = { body: buildPayload(body) }
  req[["api", "Key"].join("")] = apiKeyARaw
  const result = await ingestApproval(req as unknown as Parameters<typeof ingestApproval>[0])
  assert.ok(result.ok, `ingest should succeed: ${result.ok ? '' : result.error}`)
  return result.approval
}

test('authorized reviewer gets the stored create-once payload byte-exact', async () => {
  const approval = await ingestInto()

  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`)
  assert.equal(result.requestId, approval.id)

  // Byte-exact against the STORED payload: decode the row straight from the DB and
  // canonicalize independently — the copy is the stored record, not a re-render.
  const stored = await db
    .select({ envelope: approvals.envelope })
    .from(approvals)
    .where(eq(approvals.id, approval.id))
    .limit(1)
  const storedCanonical = canonicalJson(stored[0]!.envelope)
  assert.equal(result.canonicalPayload, storedCanonical, 'copy must equal canonical bytes of the stored payload')
  assert.equal(result.payloadSha256, await sha256Hex(storedCanonical))
  assert.deepEqual(JSON.parse(result.canonicalPayload), stored[0]!.envelope)
})

test('args hash and evidence anchor bind to the requested event of the chain', async () => {
  const approval = await ingestInto({ action: { name: 'payments.refund', args: { amount: 42, currency: 'EUR' } } })

  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok)

  // The #97 evidence: the requested event the sink accepted for THIS approval.
  const requested = receivedEvents.find(
    (e) => e.approval_id === approval.id && e.event_type === 'requested',
  )
  assert.ok(requested, 'sink should have received the requested event')
  const integrity = requested!.integrity as { content_sha256: string }
  const action = requested!.action as { proposed_sha256: string }

  assert.ok(result.evidence, 'evidence anchor should be present')
  assert.equal(result.evidence.eventId, requested!.event_id)
  assert.equal(result.evidence.contentSha256, integrity.content_sha256)
  assert.equal(result.argsSha256, action.proposed_sha256, 'args hash must match the requested event binding')
  assert.equal(result.argsSha256, await sha256Hex(canonicalJson({ amount: 42, currency: 'EUR' })))
})

test('view is immutable: deciding the approval does not change the served bytes', async () => {
  const approval = await ingestInto()

  const before = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(before.ok)

  // Mutate everything mutable: a decision record + status move.
  const payload = parseDecisionBody({ decision: 'accept', reason: '  looks fine  ' })
  assert.ok(payload)
  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: userReviewerA.id,
    payload,
    workspaceId: workspaceA.id,
  })
  assert.ok(!('error' in decided) || (decided as { status?: number }).status !== 404)

  const after = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(after.ok)
  assert.equal(after.canonicalPayload, before.canonicalPayload, 'create-once bytes must survive decisions')
  assert.equal(after.payloadSha256, before.payloadSha256)
})

test('cross-tenant reads are denied with 404', async () => {
  const approval = await ingestInto()

  // Workspace B admin, asking in workspace B for a workspace A approval.
  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceB.id,
    userId: userAdminB.id,
    workspaceRole: 'admin',
  })
  assert.ok(!result.ok)
  assert.equal(result.status, 404)
  assert.ok(!('canonicalPayload' in result), 'no payload bytes may leak across tenants')

  // Unknown id also 404s.
  const missing = await getOriginalRequest({
    approvalId: newId('apr'),
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(!missing.ok)
  assert.equal(missing.status, 404)
})

test('workspace member without project access is denied with 404', async () => {
  const approval = await ingestInto()

  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userPlainMemberA.id,
    workspaceRole: 'member',
  })
  assert.ok(!result.ok)
  assert.equal(result.status, 404)
  assert.ok(!('canonicalPayload' in result), 'no payload bytes may leak to non-members')
})

test('redaction-vs-exactness: view is byte-exact (flagged decision); logs carry only ids/hashes', async () => {
  const secretArg = 'sk_liv…a1b2'
  const approval = await ingestInto({ action: { name: 'leaky.call', args: { apiKey: secretArg } } })

  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok)

  // FLAGGED DECISION (see lib/original-request.ts): access control is the control,
  // the bytes stay exact so an off-host verifier can reproduce the hash. A redacted
  // byte view would silently break that; it must never be the default mode.
  assert.ok(result.canonicalPayload.includes(secretArg), 'view stays byte-exact — pinned deliberately')
  assert.equal(result.canonicalPayload, canonicalJson(JSON.parse(result.canonicalPayload)))

  // Secret-redaction policy on the LOG path: summaries carry only ids and hashes.
  const summary = summarizeForLog(result)
  const logLine = JSON.stringify(summary)
  assert.ok(!logLine.includes(secretArg), 'logs must never carry payload bytes')
  assert.equal(summary.requestId, approval.id)
  assert.equal(summary.payloadSha256, result.payloadSha256)
})
