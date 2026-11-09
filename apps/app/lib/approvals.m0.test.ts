/**
 * M0 host gaps against real Postgres: create-once replay inside the published
 * retention window (hitl-spec 3.2), hitl/response/v0 reads with an API key (4),
 * requester cancel, the key-scoped pending list, and the JCS argsHash (3.8).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import Ajv2020 from 'ajv/dist/2020'
import { argsHash } from '@hitly/core'
import {
  approvals,
  decisionRecords,
  memberships,
  projectApiKeys,
  projectEvents,
  projects,
  users,
  workspaces,
} from '@hitly/db/schema'
import {
  cancelApprovalAsRequester,
  decideApproval,
  getApprovalForOrigin,
  ingestApproval,
  listRequesterPending,
  parseDecisionBody,
} from './approvals'
import { DEFAULT_CREATE_ONCE_RETENTION_DAYS } from './create-once'
import { generateApiKey } from './keys'
import { newId } from './ids'
import { GET as listRoute, POST as ingestRoute } from '../app/api/v1/approvals/route'
import { POST as cancelRoute } from '../app/api/v1/approvals/[id]/cancel/route'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hitly:hitly@localhost:5432/hitly'
if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')

const DAY = 24 * 60 * 60 * 1000
const fixtures = new URL('../../../packages/core/src/fixtures/hitl-spec/', import.meta.url)
const ajv = new Ajv2020({ strict: false, allErrors: true })
// RFC 3339 date-time (the schemas' only format), without pulling in ajv-formats.
ajv.addFormat('date-time', (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)))
ajv.addSchema(JSON.parse(readFileSync(new URL('event.schema.json', fixtures), 'utf8')))
const validateResponse = ajv.compile(JSON.parse(readFileSync(new URL('response.schema.json', fixtures), 'utf8')))

let client: pg.Client
let db: ReturnType<typeof drizzle>
const workspace = { id: newId('wsp'), name: 'M0 Workspace', slug: `m0-${Date.now()}` }
const reviewer = { id: newId('usr'), email: `m0-reviewer-${Date.now()}@test.hitly.net`, name: 'M0 Reviewer' }
const projectP = { id: newId('prj'), workspaceId: workspace.id, name: 'M0 Project P' }
const projectQ = { id: newId('prj'), workspaceId: workspace.id, name: 'M0 Project Q' }
type Key = { raw: string; id: string }
let keyP1: Key
let keyP2: Key
let keyQ: Key

async function insertKey(projectId: string, name: string): Promise<Key> {
  const gen = generateApiKey()
  const id = newId('key')
  await db.insert(projectApiKeys).values({
    id,
    projectId,
    workspaceId: workspace.id,
    hashedKey: gen.hashed,
    prefix: gen.prefix,
    name,
    createdAt: new Date(),
  })
  return { raw: gen.raw, id }
}

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  // @ts-expect-error - Client vs Pool type mismatch, works at runtime
  db = drizzle(client)
  await db.insert(workspaces).values(workspace)
  await db.insert(users).values({ ...reviewer, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(memberships).values({ id: newId('mem'), workspaceId: workspace.id, userId: reviewer.id, role: 'admin', createdAt: new Date() })
  for (const project of [projectP, projectQ]) {
    await db.insert(projects).values({
      ...project,
      plugin: 'mastra',
      credentials: {},
      evidenceSinkType: 'none',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }
  keyP1 = await insertKey(projectP.id, 'P key 1')
  keyP2 = await insertKey(projectP.id, 'P key 2')
  keyQ = await insertKey(projectQ.id, 'Q key')
})

after(async () => {
  if (db) {
    await db.delete(decisionRecords).where(eq(decisionRecords.workspaceId, workspace.id))
    await db.delete(projectEvents).where(eq(projectEvents.workspaceId, workspace.id))
    await db.delete(approvals).where(eq(approvals.workspaceId, workspace.id))
    await db.delete(projectApiKeys).where(eq(projectApiKeys.workspaceId, workspace.id))
    await db.delete(projects).where(eq(projects.workspaceId, workspace.id))
    await db.delete(memberships).where(eq(memberships.workspaceId, workspace.id))
    await db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await db.delete(users).where(eq(users.id, reviewer.id))
  }
  if (client) await client.end()
})

function payload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: newId('run'),
    workflowId: 'm0-workflow',
    stepId: 'm0-step',
    mastraBaseUrl: 'http://localhost:4111',
    action: { name: 'pay', args: { amount: 100, currency: 'EUR' } },
    suspendPayload: { reason: 'M0 approval', contextMarkdown: 'ctx' },
    ...overrides,
  }
}

async function ingest(key: Key, idempotencyKey?: string, body = payload(), now?: number) {
  const result = await ingestApproval({ apiKey: key.raw, body, idempotencyKey, now })
  if (!result.ok) throw new Error(`ingest failed: ${result.error}`)
  return result
}

async function rowsFor(idempotencyKey: string) {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.projectId, projectP.id), eq(approvals.idempotencyKey, idempotencyKey)))
}

async function setRow(id: string, values: Partial<typeof approvals.$inferInsert>) {
  await db.update(approvals).set(values).where(eq(approvals.id, id))
}

test('migration 0006: approvals.requester_key_id is nullable, FK set null, indexed', async () => {
  const cols = await client.query(
    `select is_nullable, data_type from information_schema.columns where table_name = 'approvals' and column_name = 'requester_key_id'`,
  )
  assert.equal(cols.rows.length, 1)
  assert.equal(cols.rows[0].is_nullable, 'YES')
  const fk = await client.query(
    `select confdeltype from pg_constraint where conrelid = 'approvals'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%requester_key_id%'`,
  )
  assert.equal(fk.rows[0]?.confdeltype, 'n', 'ON DELETE SET NULL')
  const idx = await client.query(`select 1 from pg_indexes where indexname = 'approvals_requester_key_status_idx'`)
  assert.equal(idx.rows.length, 1)
})

test('ingest records the requester key and returns JCS argsHash and the create-once policy', async () => {
  const response = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyP1.raw}`, 'content-type': 'application/json', 'idempotency-key': `idem-${newId('t')}` },
      body: JSON.stringify(payload()),
    }),
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as { id: string; replayed: boolean; argsHash: string; createOnce: { retentionSeconds: number } }
  assert.equal(body.replayed, false)
  assert.equal(body.argsHash, await argsHash({ amount: 100, currency: 'EUR' }))
  assert.match(body.argsHash, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(body.createOnce, { retentionSeconds: DEFAULT_CREATE_ONCE_RETENTION_DAYS * 86400 })
  const [row] = await db.select().from(approvals).where(eq(approvals.id, body.id))
  assert.equal(row?.requesterKeyId, keyP1.id)
})

test('create-once: replay of an open request returns the original unchanged, no new row', async () => {
  const idem = `idem-${newId('t')}`
  const first = await ingest(keyP1, idem)
  const second = await ingest(keyP1, idem, payload({ action: { name: 'pay', args: { amount: 999999 } } }))
  assert.equal(second.replayed, true)
  assert.equal(second.approval.id, first.approval.id)
  assert.deepEqual((second.approval.envelope as { action: { args: unknown } }).action.args, { amount: 100, currency: 'EUR' })
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: replay after a decision (decided) returns the decided request, no new ask', async () => {
  const idem = `idem-${newId('t')}`
  const first = await ingest(keyP1, idem)
  const decision = parseDecisionBody({ decision: 'accept' })
  assert.ok(decision)
  await decideApproval({ approvalId: first.approval.id, actorUserId: reviewer.id, payload: decision, workspaceId: workspace.id })
  // The resume target is not running here, so settle the row as decided (closed).
  await setRow(first.approval.id, { status: 'decided' })
  const replay = await ingest(keyP1, idem)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, first.approval.id)
  assert.equal(replay.approval.status, 'decided')
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: replay after a requester cancel returns the cancelled request', async () => {
  const idem = `idem-${newId('t')}`
  const first = await ingest(keyP1, idem)
  const cancelled = await cancelApprovalAsRequester({ apiKey: keyP1.raw, approvalId: first.approval.id })
  assert.ok(cancelled.ok)
  const replay = await ingest(keyP1, idem)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, first.approval.id)
  assert.equal(replay.approval.status, 'cancelled')
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once window boundary: created exactly at the cutoff -> new request; 1 ms inside -> replay', async () => {
  const now = Date.now()
  const cutoff = now - DEFAULT_CREATE_ONCE_RETENTION_DAYS * DAY

  const idemOut = `idem-${newId('t')}`
  const outside = await ingest(keyP1, idemOut)
  await setRow(outside.approval.id, { status: 'expired', createdAt: new Date(cutoff) })
  const fresh = await ingest(keyP1, idemOut, payload(), now)
  assert.equal(fresh.replayed, false)
  assert.notEqual(fresh.approval.id, outside.approval.id)
  assert.equal((await rowsFor(idemOut)).length, 2)

  const idemIn = `idem-${newId('t')}`
  const inside = await ingest(keyP1, idemIn)
  await setRow(inside.approval.id, { status: 'expired', createdAt: new Date(cutoff + 1) })
  const replay = await ingest(keyP1, idemIn, payload(), now)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, inside.approval.id)
  assert.equal((await rowsFor(idemIn)).length, 1)
})

test('create-once: an open request older than the window still replays (never a duplicate ask)', async () => {
  const idem = `idem-${newId('t')}`
  const first = await ingest(keyP1, idem)
  await setRow(first.approval.id, { createdAt: new Date(Date.now() - 30 * DAY) })
  const replay = await ingest(keyP1, idem)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, first.approval.id)
})

test('create-once: HITLY_CREATE_ONCE_RETENTION_DAYS overrides the window', async () => {
  const previous = process.env.HITLY_CREATE_ONCE_RETENTION_DAYS
  process.env.HITLY_CREATE_ONCE_RETENTION_DAYS = '1'
  try {
    const idemOld = `idem-${newId('t')}`
    const old = await ingest(keyP1, idemOld)
    await setRow(old.approval.id, { status: 'cancelled', createdAt: new Date(Date.now() - 2 * DAY) })
    assert.equal((await ingest(keyP1, idemOld)).replayed, false, '2 days > 1-day window')

    const idemRecent = `idem-${newId('t')}`
    const recent = await ingest(keyP1, idemRecent)
    await setRow(recent.approval.id, { status: 'cancelled', createdAt: new Date(Date.now() - DAY / 2) })
    assert.equal((await ingest(keyP1, idemRecent)).replayed, true)
  } finally {
    if (previous === undefined) delete process.env.HITLY_CREATE_ONCE_RETENTION_DAYS
    else process.env.HITLY_CREATE_ONCE_RETENTION_DAYS = previous
  }
})

test('create-once: concurrent submissions of a new key create exactly one request', async () => {
  const idem = `idem-${newId('t')}`
  const results = await Promise.all(Array.from({ length: 6 }, () => ingest(keyP1, idem)))
  assert.equal(new Set(results.map((r) => r.approval.id)).size, 1)
  assert.equal(results.filter((r) => !r.replayed).length, 1)
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: ingest waits on the per-project, per-key advisory lock', async () => {
  const idem = `idem-${newId('t')}`
  const locker = new pg.Client({ connectionString: DATABASE_URL })
  await locker.connect()
  try {
    await locker.query('begin')
    await locker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`hitly:create-once:${projectP.id}:${idem}`])
    let settled = false
    const pending = ingest(keyP1, idem).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(settled, false, 'ingest must block while another submission of the same key holds the lock')
    await locker.query('commit')
    const result = await pending
    assert.equal(result.replayed, false)
    assert.equal((await rowsFor(idem)).length, 1)
  } finally {
    await locker.end()
  }
})

test('create-once is per project: the same key in another project is a different request', async () => {
  const idem = `idem-${newId('t')}`
  const p = await ingest(keyP1, idem)
  const q = await ingest(keyQ, idem, payload({ projectId: projectQ.id }))
  assert.equal(q.replayed, false)
  assert.notEqual(q.approval.id, p.approval.id)
})

test('API-key read: open request has hitl null plus argsHash; decided read is a valid hitl/response/v0', async () => {
  const created = await ingest(keyP1)
  const open = await getApprovalForOrigin({ apiKey: keyP1.raw, approvalId: created.approval.id })
  if (!open.ok) throw new Error(open.error)
  assert.equal(open.hitl, null)
  assert.equal(open.argsHash, await argsHash({ amount: 100, currency: 'EUR' }))
  assert.deepEqual(open.activity, { presentedAt: null, items: [] })

  const decision = parseDecisionBody({ decision: 'accept' })
  assert.ok(decision)
  await decideApproval({ approvalId: created.approval.id, actorUserId: reviewer.id, payload: decision, workspaceId: workspace.id })
  const read = await getApprovalForOrigin({ apiKey: keyP1.raw, approvalId: created.approval.id })
  if (!read.ok) throw new Error(read.error)
  assert.equal(read.decision, 'accept', 'legacy field kept')
  assert.ok(validateResponse(read.hitl), JSON.stringify(validateResponse.errors))
  assert.equal(read.hitl?.status, 'answered')
  assert.equal(read.hitl?.value, 'approve')
  assert.equal(read.hitl?.requestId, created.approval.id)
  assert.deepEqual(read.hitl?.decidedBy, { kind: 'human', id: reviewer.id })
  assert.equal(read.hitl?.argsHash, open.argsHash)

  // Reads are project-scoped: a sibling key on the same project can read; another project's key cannot.
  const sibling = await getApprovalForOrigin({ apiKey: keyP2.raw, approvalId: created.approval.id })
  assert.ok(sibling.ok)
  const foreign = await getApprovalForOrigin({ apiKey: keyQ.raw, approvalId: created.approval.id })
  assert.equal(foreign.ok, false)
})

test('requester cancel: only the creating key may cancel; others get 404 and nothing changes', async () => {
  const created = await ingest(keyP1)
  const id = created.approval.id

  const sibling = await cancelApprovalAsRequester({ apiKey: keyP2.raw, approvalId: id })
  assert.deepEqual(sibling, { ok: false, error: 'Not found', status: 404 })
  const foreign = await cancelApprovalAsRequester({ apiKey: keyQ.raw, approvalId: id })
  assert.equal(foreign.ok ? 200 : foreign.status, 404)
  const bad = await cancelApprovalAsRequester({ apiKey: 'hk_not_a_key', approvalId: id })
  assert.equal(bad.ok ? 200 : bad.status, 401)
  let [row] = await db.select().from(approvals).where(eq(approvals.id, id))
  assert.equal(row?.status, 'pending')
  assert.equal((await db.select().from(decisionRecords).where(eq(decisionRecords.approvalId, id))).length, 0)

  const routeRefused = await cancelRoute(
    new Request(`http://localhost/api/v1/approvals/${id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${keyP2.raw}` } }),
    { params: Promise.resolve({ id }) },
  )
  assert.equal(routeRefused.status, 404)

  const routeOk = await cancelRoute(
    new Request(`http://localhost/api/v1/approvals/${id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keyP1.raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'run superseded' }),
    }),
    { params: Promise.resolve({ id }) },
  )
  assert.equal(routeOk.status, 200)
  assert.deepEqual(await routeOk.json(), { id, status: 'cancelled', decision: 'cancel', by: 'requester' })
  ;[row] = await db.select().from(approvals).where(eq(approvals.id, id))
  assert.equal(row?.status, 'cancelled')
  const records = await db.select().from(decisionRecords).where(eq(decisionRecords.approvalId, id))
  assert.equal(records.length, 1)
  assert.equal(records[0]?.decision, 'cancel')
  assert.equal(records[0]?.actorUserId, null, 'not a reviewer action')

  const read = await getApprovalForOrigin({ apiKey: keyP1.raw, approvalId: id })
  if (!read.ok) throw new Error(read.error)
  assert.ok(validateResponse(read.hitl), JSON.stringify(validateResponse.errors))
  assert.equal(read.hitl?.status, 'cancelled')
  assert.equal(read.hitl?.reason, 'run superseded')
  assert.equal(read.hitl?._meta?.['net.hitly/cancelledBy'], 'requester')

  const again = await cancelApprovalAsRequester({ apiKey: keyP1.raw, approvalId: id })
  assert.equal(again.ok ? 200 : again.status, 409)
})

test('requester cancel: refused once answered or expired', async () => {
  const answered = await ingest(keyP1)
  const decision = parseDecisionBody({ decision: 'accept' })
  assert.ok(decision)
  await decideApproval({ approvalId: answered.approval.id, actorUserId: reviewer.id, payload: decision, workspaceId: workspace.id })
  const late = await cancelApprovalAsRequester({ apiKey: keyP1.raw, approvalId: answered.approval.id })
  assert.equal(late.ok ? 200 : late.status, 409)

  const stale = await ingest(keyP1)
  await setRow(stale.approval.id, { expiresAt: new Date(Date.now() - 1000) })
  const expired = await cancelApprovalAsRequester({ apiKey: keyP1.raw, approvalId: stale.approval.id })
  assert.equal(expired.ok ? 200 : expired.status, 409)
  const [row] = await db.select().from(approvals).where(eq(approvals.id, stale.approval.id))
  assert.equal(row?.status, 'expired')
})

test('pending list: scoped to the calling key, open and unexpired only', async () => {
  // Fresh keys so earlier tests do not leak into the list.
  const k1 = await insertKey(projectP.id, 'list key 1')
  const k2 = await insertKey(projectP.id, 'list key 2')
  const a = await ingest(k1)
  const b = await ingest(k1)
  const c = await ingest(k2)
  const gone = await ingest(k1)
  await cancelApprovalAsRequester({ apiKey: k1.raw, approvalId: gone.approval.id })
  const stale = await ingest(k1)
  await setRow(stale.approval.id, { expiresAt: new Date(Date.now() - 1000) })
  // A legacy row (created before requester_key_id existed) is never listed.
  const legacy = await ingest(k1)
  await setRow(legacy.approval.id, { requesterKeyId: null })

  const list1 = await listRequesterPending({ apiKey: k1.raw })
  if (!list1.ok) throw new Error(list1.error)
  assert.deepEqual(new Set(list1.items.map((i) => i.id)), new Set([a.approval.id, b.approval.id]))
  assert.equal(list1.items[0]?.kind, 'approval')
  assert.equal(list1.items[0]?.actionName, 'pay')
  const list2 = await listRequesterPending({ apiKey: k2.raw })
  if (!list2.ok) throw new Error(list2.error)
  assert.deepEqual(list2.items.map((i) => i.id), [c.approval.id])
  const listQ = await listRequesterPending({ apiKey: keyQ.raw })
  if (!listQ.ok) throw new Error(listQ.error)
  assert.equal(listQ.items.some((i) => [a, b, c].some((x) => x.approval.id === i.id)), false)

  const limited = await listRequesterPending({ apiKey: k1.raw, limit: 1 })
  assert.ok(limited.ok && limited.items.length === 1)
  const wrongProject = await listRequesterPending({ apiKey: k1.raw, projectId: projectQ.id })
  assert.equal(wrongProject.ok, false)

  const legacyCancel = await cancelApprovalAsRequester({ apiKey: k1.raw, approvalId: legacy.approval.id })
  assert.equal(legacyCancel.ok ? 200 : legacyCancel.status, 404)

  const route = await listRoute(
    new Request(`http://localhost/api/v1/approvals?projectId=${projectP.id}&limit=10`, { headers: { authorization: `Bearer ${k2.raw}` } }),
  )
  assert.equal(route.status, 200)
  const routeBody = (await route.json()) as { status: string; items: Array<{ id: string }> }
  assert.equal(routeBody.status, 'open')
  assert.deepEqual(routeBody.items.map((i) => i.id), [c.approval.id])
  const noAuth = await listRoute(new Request('http://localhost/api/v1/approvals'))
  assert.equal(noAuth.status, 401)
  const badStatus = await listRoute(new Request('http://localhost/api/v1/approvals?status=closed', { headers: { authorization: `Bearer ${k2.raw}` } }))
  assert.equal(badStatus.status, 400)
  const badLimit = await listRoute(new Request('http://localhost/api/v1/approvals?limit=ten', { headers: { authorization: `Bearer ${k2.raw}` } }))
  assert.equal(badLimit.status, 400)
})

test('deleting the requester key keeps the request (FK set null)', async () => {
  const k = await insertKey(projectP.id, 'doomed key')
  const created = await ingest(k)
  await db.delete(projectApiKeys).where(eq(projectApiKeys.id, k.id))
  const [row] = await db.select().from(approvals).where(eq(approvals.id, created.approval.id))
  assert.equal(row?.requesterKeyId, null)
  assert.equal(row?.status, 'pending')
})
