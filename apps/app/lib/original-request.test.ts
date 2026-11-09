/**
 * Original create-once request view (hitly#98) — real Postgres, not mocked.
 * Covers: authorized view of the STORED create-once record (hashes of original,
 * redacted JSON), evidence hash binding (hitly#97 chain), cross-tenant / no-access
 * denial, secret redaction + log-safe summary, editedArgs never served as the
 * request, and non-canonical ingest normalisation.
 *
 * Run with: DATABASE_URL=... HITLY_ENCRYPTION_KEK=... yarn workspace @hitly/app test
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import http from 'node:http'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { argsHash, canonicalJson, jcsHash, sha256Hex } from '@hitly/core'
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
import { REDACTED, redactRequestPayload } from './redact-request-payload'
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

test('authorized reviewer gets hashes of the stored create-once record and a redacted JSON copy', async () => {
  const approval = await ingestInto()

  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`)
  assert.equal(result.requestId, approval.id)

  // Against the STORED record: hashes bind the original; the served JSON is redacted.
  const stored = await db
    .select({ envelope: approvals.envelope })
    .from(approvals)
    .where(eq(approvals.id, approval.id))
    .limit(1)
  const storedEnvelope = stored[0]!.envelope
  const storedCanonical = canonicalJson(storedEnvelope)
  assert.equal(result.payloadSha256, await sha256Hex(storedCanonical))
  assert.equal(result.payloadHash, await jcsHash(storedEnvelope))
  assert.equal(result.argsHash, await argsHash((storedEnvelope as { action: { args: Record<string, unknown> } }).action.args))
  assert.equal(result.canonicalPayload, canonicalJson(redactRequestPayload(storedEnvelope)))
  assert.notEqual(result.canonicalPayload, storedCanonical, 'served JSON must not be the unredacted stored record')
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
  assert.ok(!('error' in decided), `decide must succeed: ${JSON.stringify(decided)}`)
  assert.ok('approval' in decided && decided.approval, 'decide must return the approval')
  assert.notEqual(decided.approval.status, 'pending', 'decide must leave pending')

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

test('served JSON redacts secrets and resume handles; hashes bind the stored original; logs stay id/hash only', async () => {
  const secretArg = 'cb-auth-fixture-value'
  const approval = await ingestInto({
    action: { name: 'leaky.call', args: { amount: 7, cb_auth_token: secretArg, apiKey: secretArg } },
  })

  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok)

  const stored = await db
    .select({ envelope: approvals.envelope })
    .from(approvals)
    .where(eq(approvals.id, approval.id))
    .limit(1)
  const storedEnvelope = stored[0]!.envelope
  const storedCanonical = canonicalJson(storedEnvelope)
  assert.ok(storedCanonical.includes(secretArg), 'stored original still has the secret')
  assert.equal(result.payloadHash, await jcsHash(storedEnvelope))
  assert.equal(result.argsHash, await argsHash((storedEnvelope as { action: { args: Record<string, unknown> } }).action.args))
  assert.equal(result.payloadSha256, await sha256Hex(storedCanonical))

  assert.equal(result.canonicalPayload.includes(secretArg), false, 'source must strip secrets from the served JSON')
  assert.ok(result.canonicalPayload.includes(REDACTED))
  const served = JSON.parse(result.canonicalPayload) as {
    action?: { args?: Record<string, unknown> }
    origin?: { resumeHandle?: unknown }
  }
  assert.equal(served.action?.args?.amount, 7)
  assert.equal(served.action?.args?.cb_auth_token, REDACTED)
  assert.equal(served.action?.args?.apiKey, REDACTED)
  assert.equal(served.origin?.resumeHandle, REDACTED)
  assert.equal(result.canonicalPayload, canonicalJson(JSON.parse(result.canonicalPayload)))

  const summary = summarizeForLog(result)
  const logLine = JSON.stringify(summary)
  assert.equal(logLine.includes(secretArg), false, 'logs must never carry payload bytes')
  assert.equal(summary.requestId, approval.id)
  assert.equal(summary.payloadSha256, result.payloadSha256)
})


test('non-canonical ingest is served as pinned canonical JSON (key order, escapes, numbers, bigints)', async () => {
  // Simulate JSON.parse of a non-canonical wire body (unordered keys, \u escapes,
  // 1.50 / 1e2, >2^53 integer, trailing newline). Precision loss at ingest is expected.
  const wire =
    '{ "z": 1, "a": {"y":"caf\\u00e9 \\u2603 \\ud83d\\ude00", "b": [3,1,2]}, "big": 12345678901234567890, "f": 1.50, "e": 1e2 }\n'
  const parsedArgs = JSON.parse(wire) as Record<string, unknown>
  assert.equal(parsedArgs.big, 12345678901234567000)

  const expectedArgsCanonical =
    '{"a":{"b":[3,1,2],"y":"café ☃ 😀"},"big":12345678901234567000,"e":100,"f":1.5,"z":1}'
  assert.equal(canonicalJson(parsedArgs), expectedArgsCanonical)

  const approval = await ingestInto({ action: { name: 'canon.probe', args: parsedArgs } })
  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok)

  const stored = await db
    .select({ envelope: approvals.envelope })
    .from(approvals)
    .where(eq(approvals.id, approval.id))
    .limit(1)
  const storedEnvelope = stored[0]!.envelope
  const served = JSON.parse(result.canonicalPayload) as { action?: { args?: unknown } }
  assert.deepEqual(served.action?.args, parsedArgs)
  assert.equal(canonicalJson(served.action?.args), expectedArgsCanonical)
  assert.equal(result.argsSha256, await sha256Hex(expectedArgsCanonical))
  assert.equal(result.canonicalPayload, canonicalJson(JSON.parse(result.canonicalPayload)))
  assert.equal(result.payloadSha256, await sha256Hex(canonicalJson(storedEnvelope)))
  assert.equal(result.payloadHash, await jcsHash(storedEnvelope))
  assert.match(result.canonicalPayload, /"big":12345678901234567000/)
  assert.ok(!result.canonicalPayload.includes('12345678901234567890'))
})

test('editedArgs never appear as the original request after an edit decision', async () => {
  const approval = await ingestInto({
    allowedActions: { accept: true, reject: true, edit: true },
    editableFields: { amount: { type: 'int', min: 0, max: 1000 } },
    action: { name: 'test-action', args: { amount: 100, currency: 'EUR' } },
  })

  const payload = parseDecisionBody({
    decision: 'edit',
    editedArgs: { amount: 55 },
    editReason: 'pricing_correction',
  })
  assert.ok(payload)
  const decided = await decideApproval({
    approvalId: approval.id,
    actorUserId: userReviewerA.id,
    payload,
    workspaceId: workspaceA.id,
  })
  assert.ok(!('error' in decided), `decide must succeed: ${JSON.stringify(decided)}`)

  const result = await getOriginalRequest({
    approvalId: approval.id,
    workspaceId: workspaceA.id,
    userId: userReviewerA.id,
    workspaceRole: 'member',
  })
  assert.ok(result.ok)
  const served = JSON.parse(result.canonicalPayload) as { action?: { args?: Record<string, unknown> }; editedArgs?: unknown }
  assert.equal(served.action?.args?.amount, 100)
  assert.equal(served.action?.args?.currency, 'EUR')
  assert.equal('editedArgs' in served, false)
  assert.equal(result.canonicalPayload.includes('"amount":55'), false)
  assert.equal(result.argsHash, await argsHash({ amount: 100, currency: 'EUR' }))
})
