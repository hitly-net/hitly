/**
 * M0 host gaps against real Postgres: create-once replay inside the published
 * retention window (hitl-spec 3.2), scoped to the creating API key (D3),
 * same-payloadHash replay vs 409 idempotency_conflict on a changed body,
 * hitl/response/v0 reads with an API key (4),
 * requester cancel, the key-scoped pending list, and the JCS argsHash (3.8).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import Ajv2020 from 'ajv/dist/2020'
import { argsHash, jcsHash } from '@hitly/core'
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
  REQUESTER_PENDING_MAX_LIMIT,
} from './approvals'
import { getOriginalRequest } from './original-request'
import { encodeTenantJson } from './tenant-crypto'
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

test('create-once: same payloadHash replays the original unchanged, no new row', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)
  // Key order in args differs; JCS payloadHash still matches.
  const shuffled = {
    ...body,
    action: { name: 'pay', args: { currency: 'EUR', amount: 100 } },
  }
  const second = await ingest(keyP1, idem, shuffled)
  assert.equal(second.replayed, true)
  assert.equal(second.approval.id, first.approval.id)
  assert.deepEqual((second.approval.envelope as { action: { args: unknown } }).action.args, { amount: 100, currency: 'EUR' })
  assert.equal((await rowsFor(idem)).length, 1)

  const route = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyP1.raw}`, 'idempotency-key': idem, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  assert.equal(route.status, 200)
  const routeBody = (await route.json()) as { id: string; replayed: boolean }
  assert.equal(routeBody.replayed, true)
  assert.equal(routeBody.id, first.approval.id)
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: different payloadHash is 409 idempotency_conflict, no new row and no replay', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)
  const conflict = await ingestApproval({
    apiKey: keyP1.raw,
    body: payload({ action: { name: 'pay', args: { amount: 999999 } } }),
    idempotencyKey: idem,
  })
  assert.equal(conflict.ok, false)
  if (conflict.ok) throw new Error('a changed payload must not replay')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'idempotency_conflict')
  assert.equal(conflict.error, 'Idempotency-Key reused with a different payload')
  assert.deepEqual(Object.keys(conflict).sort(), ['code', 'error', 'ok', 'status'])
  const disclosed = JSON.stringify(conflict)
  assert.ok(!disclosed.includes(first.approval.id), 'conflict must not replay the stored id')
  assert.ok(!disclosed.includes('replayed'), 'conflict must not replay the stored response')
  assert.equal((await rowsFor(idem)).length, 1)
  const [row] = await rowsFor(idem)
  assert.equal(row?.id, first.approval.id)
  assert.deepEqual(
    ((await ingest(keyP1, idem, body)).approval.envelope as { action: { args: unknown } }).action.args,
    { amount: 100, currency: 'EUR' },
  )

  const route = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyP1.raw}`, 'idempotency-key': idem, 'content-type': 'application/json' },
      body: JSON.stringify(payload({ action: { name: 'pay', args: { amount: 1 } } })),
    }),
  )
  assert.equal(route.status, 409)
  const routeBody = (await route.json()) as Record<string, unknown>
  assert.equal(routeBody.code, 'idempotency_conflict')
  assert.equal(routeBody.error, 'Idempotency-Key reused with a different payload')
  assert.deepEqual(Object.keys(routeBody).sort(), ['code', 'error'])
  assert.equal((await rowsFor(idem)).length, 1)

  const conflictLogs = await db
    .select()
    .from(projectEvents)
    .where(and(eq(projectEvents.approvalId, first.approval.id), eq(projectEvents.type, 'ingest')))
  const conflictLog = conflictLogs.find((row) => row.message.includes('payloadHash does not match'))
  assert.ok(conflictLog, '409 must write a create-once conflict log row')
  assert.ok(
    conflictLog.message.includes(first.approval.id),
    `409 log line must include approvalId, got ${conflictLog.message}`,
  )
  assert.equal(conflictLog.approvalId, first.approval.id)
  const logged = JSON.stringify({ message: conflictLog.message, payload: conflictLog.payload })
  assert.ok(!logged.includes('999999'), '409 log must not include the request payload')
  assert.ok(!logged.includes(keyP1.raw), '409 log must not include the API key secret')
  assert.ok(!logged.includes('hitly_'), '409 log must not include raw key material')
})

test('create-once: same request differing only in origin is 409 payloadHash mismatch', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)
  const conflict = await ingestApproval({
    apiKey: keyP1.raw,
    body: { ...body, runId: newId('run') },
    idempotencyKey: idem,
  })
  assert.equal(conflict.ok, false)
  if (conflict.ok) throw new Error('an origin-only change must not replay')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'idempotency_conflict')
  assert.equal(conflict.error, 'Idempotency-Key reused with a different payload')
  assert.equal((await rowsFor(idem)).length, 1)
  assert.equal((await ingest(keyP1, idem, body)).approval.id, first.approval.id)

  const route = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyP1.raw}`, 'idempotency-key': idem, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, mastraBaseUrl: 'https://origin.example/other' }),
    }),
  )
  assert.equal(route.status, 409)
  const routeBody = (await route.json()) as Record<string, unknown>
  assert.equal(routeBody.code, 'idempotency_conflict')
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: same request differing only in expiresAt is 409 payloadHash mismatch', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload({ expiresAt: '2026-12-01T00:00:00.000Z' })
  const first = await ingest(keyP1, idem, body)
  const conflict = await ingestApproval({
    apiKey: keyP1.raw,
    body: { ...body, expiresAt: '2026-12-02T00:00:00.000Z' },
    idempotencyKey: idem,
  })
  assert.equal(conflict.ok, false)
  if (conflict.ok) throw new Error('an expiresAt-only change must not replay')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'idempotency_conflict')
  assert.equal(conflict.error, 'Idempotency-Key reused with a different payload')
  assert.equal((await rowsFor(idem)).length, 1)
  assert.equal((await ingest(keyP1, idem, body)).approval.id, first.approval.id)

  const route = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyP1.raw}`, 'idempotency-key': idem, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, expiresAt: '2026-12-03T00:00:00.000Z' }),
    }),
  )
  assert.equal(route.status, 409)
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: Authorization header and extra auth headers do not change payloadHash', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)

  const replay = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${keyP1.raw}`,
        'idempotency-key': idem,
        'content-type': 'application/json',
        cookie: 'session=should-not-hash',
        'x-api-key': 'should-not-hash',
        'x-hitly-client': 'test-client',
      },
      body: JSON.stringify(body),
    }),
  )
  assert.equal(replay.status, 200)
  const replayBody = (await replay.json()) as { id: string; replayed: boolean }
  assert.equal(replayBody.replayed, true)
  assert.equal(replayBody.id, first.approval.id)
  assert.equal((await rowsFor(idem)).length, 1)

  // Extra auth/secret fields on the JSON body are dropped at ingest, so the hash is unchanged.
  const withAuthInBody = await ingest(keyP1, idem, {
    ...body,
    Authorization: 'Bearer should-not-hash',
    cookie: 'session=should-not-hash',
    resumeSecret: 'should-not-hash',
  })
  assert.equal(withAuthInBody.replayed, true)
  assert.equal(withAuthInBody.approval.id, first.approval.id)
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: replay after a decision (decided) returns the decided request, no new ask', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)
  const decision = parseDecisionBody({ decision: 'accept' })
  assert.ok(decision)
  await decideApproval({ approvalId: first.approval.id, actorUserId: reviewer.id, payload: decision, workspaceId: workspace.id })
  // The resume target is not running here, so settle the row as decided (closed).
  await setRow(first.approval.id, { status: 'decided' })
  const replay = await ingest(keyP1, idem, body)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, first.approval.id)
  assert.equal(replay.approval.status, 'decided')
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once: replay after a requester cancel returns the cancelled request', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)
  const cancelled = await cancelApprovalAsRequester({ apiKey: keyP1.raw, approvalId: first.approval.id })
  assert.ok(cancelled.ok)
  const replay = await ingest(keyP1, idem, body)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, first.approval.id)
  assert.equal(replay.approval.status, 'cancelled')
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once window boundary: created exactly at the cutoff -> new request; 1 ms inside -> replay', async () => {
  const now = Date.now()
  const cutoff = now - DEFAULT_CREATE_ONCE_RETENTION_DAYS * DAY

  const idemOut = `idem-${newId('t')}`
  const outsideBody = payload()
  const outside = await ingest(keyP1, idemOut, outsideBody)
  await setRow(outside.approval.id, { status: 'expired', createdAt: new Date(cutoff) })
  const fresh = await ingest(keyP1, idemOut, outsideBody, now)
  assert.equal(fresh.replayed, false)
  assert.notEqual(fresh.approval.id, outside.approval.id)
  assert.equal((await rowsFor(idemOut)).length, 2)

  const idemIn = `idem-${newId('t')}`
  const insideBody = payload()
  const inside = await ingest(keyP1, idemIn, insideBody)
  await setRow(inside.approval.id, { status: 'expired', createdAt: new Date(cutoff + 1) })
  const replay = await ingest(keyP1, idemIn, insideBody, now)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, inside.approval.id)
  assert.equal((await rowsFor(idemIn)).length, 1)
})

test('create-once: an open request older than the window still replays (never a duplicate ask)', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)
  await setRow(first.approval.id, { createdAt: new Date(Date.now() - 30 * DAY) })
  const replay = await ingest(keyP1, idem, body)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, first.approval.id)
})

test('create-once: HITLY_CREATE_ONCE_RETENTION_DAYS overrides the window', async () => {
  const previous = process.env.HITLY_CREATE_ONCE_RETENTION_DAYS
  process.env.HITLY_CREATE_ONCE_RETENTION_DAYS = '1'
  try {
    const idemOld = `idem-${newId('t')}`
    const oldBody = payload()
    const old = await ingest(keyP1, idemOld, oldBody)
    await setRow(old.approval.id, { status: 'cancelled', createdAt: new Date(Date.now() - 2 * DAY) })
    assert.equal((await ingest(keyP1, idemOld, oldBody)).replayed, false, '2 days > 1-day window')

    const idemRecent = `idem-${newId('t')}`
    const recentBody = payload()
    const recent = await ingest(keyP1, idemRecent, recentBody)
    await setRow(recent.approval.id, { status: 'cancelled', createdAt: new Date(Date.now() - DAY / 2) })
    assert.equal((await ingest(keyP1, idemRecent, recentBody)).replayed, true)
  } finally {
    if (previous === undefined) delete process.env.HITLY_CREATE_ONCE_RETENTION_DAYS
    else process.env.HITLY_CREATE_ONCE_RETENTION_DAYS = previous
  }
})

test('create-once: concurrent submissions of a new key create exactly one request', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const results = await Promise.all(Array.from({ length: 6 }, () => ingest(keyP1, idem, body)))
  assert.equal(new Set(results.map((r) => r.approval.id)).size, 1)
  assert.equal(results.filter((r) => !r.replayed).length, 1)
  assert.equal((await rowsFor(idem)).length, 1)
})

test('create-once replay picks the newest matching row (ORDER BY created_at DESC, id DESC)', async () => {
  // A18: reversing created_at DESC to ASC must go red. The older row has the
  // greater id, so ORDER BY id DESC only (drop-createdAt) returns the wrong
  // row. Dropping id DESC must also go red: five tied rows are inserted in
  // id ASC (lowest first), the reverse of the expected id DESC order. Without
  // the tie-break, Seq Scan + Sort on equal created_at keeps heap order and
  // LIMIT 1 returns the lowest id. Replays use one body so payloadHash matches (#108).
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)
  await setRow(first.approval.id, { idempotencyKey: `idem-${newId('t')}` })
  const second = await ingest(keyP1, idem, body)
  const t0 = Date.now() - 60_000
  // Older createdAt must have the greater id so ORDER BY id DESC only (no
  // created_at) returns the wrong row every time.
  const older = first.approval.id > second.approval.id ? first : second
  const newer = older === first ? second : first
  await setRow(older.approval.id, { idempotencyKey: idem, createdAt: new Date(t0) })
  await setRow(newer.approval.id, { idempotencyKey: idem, createdAt: new Date(t0 + 5_000) })
  assert.ok(older.approval.id > newer.approval.id, 'older row must have the greater id')

  const replay = await ingest(keyP1, idem, body)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approval.id, newer.approval.id, 'replay must return the newest matching row, not the oldest')
  assert.notEqual(replay.approval.id, older.approval.id)
  assert.equal((await rowsFor(idem)).length, 2)

  const idemTie = `idem-${newId('t')}`
  const ids = Array.from({ length: 5 }, () => newId('apr').slice(0, 36)).sort()
  const expectedOrder = [...ids].reverse()
  const same = new Date(t0 + 30_000)
  const seed = await ingest(keyP1, `seed-${newId('t')}`, body)
  const [stored] = await db.select().from(approvals).where(eq(approvals.id, seed.approval.id))
  if (!stored) throw new Error('seed row missing')
  await setRow(seed.approval.id, { idempotencyKey: `done-${newId('t')}` })
  // Insert one row at a time, lowest id first, highest last, copying the seeded
  // envelope so payloadHash matches the replay body.
  for (const id of ids) {
    await db.insert(approvals).values({
      id,
      workspaceId: workspace.id,
      projectId: projectP.id,
      plugin: 'mastra',
      status: 'pending',
      actionName: stored.actionName,
      envelope: stored.envelope,
      origin: stored.origin,
      idempotencyKey: idemTie,
      requesterKeyId: keyP1.id,
      expiresAt: stored.expiresAt ?? new Date(t0 + 3_600_000),
      createdAt: same,
    })
  }
  const heap = await client.query<{ id: string }>(
    'select id from approvals where workspace_id = $1 and project_id = $2 and idempotency_key = $3 order by ctid',
    [workspace.id, projectP.id, idemTie],
  )
  assert.deepEqual(
    heap.rows.map((row) => row.id),
    ids,
    'physical/insert order must be the reverse of id DESC (lowest id first, highest last)',
  )

  const seen: string[] = []
  for (const expected of expectedOrder) {
    const tieReplay = await ingest(keyP1, idemTie, body)
    assert.equal(tieReplay.replayed, true)
    assert.equal(
      tieReplay.approval.id,
      expected,
      `id DESC order; want ${expectedOrder.join(',')} after ${seen.join(',') || '(start)'}, got ${tieReplay.approval.id}`,
    )
    seen.push(tieReplay.approval.id)
    await setRow(tieReplay.approval.id, { idempotencyKey: `done-${newId('t')}` })
  }
  assert.deepEqual(seen, expectedOrder, 'replay must walk matching rows in id DESC order')
})

test('create-once: sibling keys racing a fresh id: one create, the other 409, no duplicate row', async () => {
  // S14: real Postgres, not mocked. Two sibling requester keys race to create
  // the same unused Idempotency-Key. Exactly one row exists afterwards: one
  // create wins, the other key gets 409.
  const RUNS = 8
  for (let run = 1; run <= RUNS; run++) {
    const idem = `idem-${newId('t')}`
    const [left, right] = await Promise.all([
      ingestApproval({ apiKey: keyP1.raw, body: payload(), idempotencyKey: idem }),
      ingestApproval({ apiKey: keyP2.raw, body: payload(), idempotencyKey: idem }),
    ])
    const winners = [left, right].filter((result) => result.ok)
    const losers = [left, right].filter((result) => !result.ok)
    assert.equal(winners.length, 1, `run ${run}: exactly one create must win`)
    assert.equal(losers.length, 1, `run ${run}: the other key must lose`)
    const winner = winners[0]
    const loser = losers[0]
    if (!winner || !winner.ok || !loser || loser.ok) throw new Error(`run ${run}: expected one ok and one error`)
    assert.equal(winner.replayed, false, `run ${run}: the winner is a create, not a replay`)
    assert.equal(loser.status, 409, `run ${run}: the losing sibling must get 409`)
    const rows = await rowsFor(idem)
    assert.equal(rows.length, 1, `run ${run}: no duplicate row`)
    assert.ok(
      rows[0]?.requesterKeyId === keyP1.id || rows[0]?.requesterKeyId === keyP2.id,
      `run ${run}: the surviving row belongs to one of the racing keys`,
    )
  }
})

test('create-once: ingest waits on the per-project, per-key advisory lock', async () => {
  const idem = `idem-${newId('t')}`
  const body = payload()
  const locker = new pg.Client({ connectionString: DATABASE_URL })
  await locker.connect()
  try {
    await locker.query('begin')
    await locker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`hitly:create-once:${projectP.id}:${idem}`])
    let settled = false
    const pending = ingest(keyP1, idem, body).finally(() => {
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
  const body = payload()
  const p = await ingest(keyP1, idem, body)
  const q = await ingest(keyQ, idem, { ...body, projectId: projectQ.id })
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

test('pending list: failed_resume rows are included in GET /api/v1/approvals open list', async () => {
  // A8d: failed_resume is an open status. Dropping it from the list filter
  // (or treating it like overdue pending) must go red here.
  const k = await insertKey(projectP.id, 'failed-resume list key')
  const failed = await ingest(k)
  await setRow(failed.approval.id, { status: 'failed_resume', expiresAt: new Date(Date.now() - 1000) })
  const pending = await ingest(k)

  const list = await listRequesterPending({ apiKey: k.raw })
  if (!list.ok) throw new Error(list.error)
  const byId = new Map(list.items.map((item) => [item.id, item]))
  assert.equal(byId.get(failed.approval.id)?.status, 'failed_resume')
  assert.equal(byId.get(pending.approval.id)?.status, 'pending')

  const route = await listRoute(
    new Request(`http://localhost/api/v1/approvals?projectId=${projectP.id}&status=open`, {
      headers: { authorization: `Bearer ${k.raw}` },
    }),
  )
  assert.equal(route.status, 200)
  const body = (await route.json()) as { status: string; items: Array<{ id: string; status: string }> }
  assert.equal(body.status, 'open')
  assert.equal(body.items.find((item) => item.id === failed.approval.id)?.status, 'failed_resume')
  assert.equal(body.items.find((item) => item.id === pending.approval.id)?.status, 'pending')
})

test('deleting the requester key keeps the request (FK set null)', async () => {
  const k = await insertKey(projectP.id, 'doomed key')
  const created = await ingest(k)
  await db.delete(projectApiKeys).where(eq(projectApiKeys.id, k.id))
  const [row] = await db.select().from(approvals).where(eq(approvals.id, created.approval.id))
  assert.equal(row?.requesterKeyId, null)
  assert.equal(row?.status, 'pending')
})

test('edit decision: stored envelope, original request and argsHash stay byte-identical; edits live only in the read', async () => {
  // M1 (gate pr104): the create-once record is write-once. Writing the merged
  // edit args back into approvals.envelope (mutant A12) must go red here.
  const created = await ingest(
    keyP1,
    undefined,
    payload({
      allowedActions: { accept: true, reject: true, edit: true },
      editableFields: { amount: { type: 'int', min: 0, max: 1000 } },
    }),
  )
  const id = created.approval.id
  const originalArgs = { amount: 100, currency: 'EUR' }

  const storedBefore = await client.query<{ text: string }>(
    'select envelope::text as text from approvals where id = $1',
    [id],
  )
  const originalBefore = await getOriginalRequest({
    approvalId: id,
    workspaceId: workspace.id,
    userId: reviewer.id,
    workspaceRole: 'admin',
  })
  if (!originalBefore.ok) throw new Error(originalBefore.error)
  assert.equal(originalBefore.argsHash, await argsHash(originalArgs))

  const decision = parseDecisionBody({
    decision: 'edit',
    editedArgs: { amount: 55 },
    editReason: 'pricing_correction',
    editReasonText: 'negotiated down',
  })
  assert.ok(decision)
  const result = await decideApproval({ approvalId: id, actorUserId: reviewer.id, payload: decision, workspaceId: workspace.id })
  if (!('approval' in result)) throw new Error(`decide failed: ${JSON.stringify(result)}`)
  assert.ok(result.status === 'decided' || result.status === 'failed_resume')

  // The stored request is unchanged: byte-identical JSONB, original args intact.
  const storedAfter = await client.query<{ text: string }>(
    'select envelope::text as text from approvals where id = $1',
    [id],
  )
  assert.equal(storedAfter.rows[0]?.text, storedBefore.rows[0]?.text, 'stored envelope changed after an edit decision')
  assert.deepEqual(
    (JSON.parse(storedAfter.rows[0]!.text) as { action: { args: unknown } }).action.args,
    originalArgs,
    'merged edit args leaked into the stored envelope',
  )

  // The original-request view (argsHash/payloadHash) is unchanged end to end.
  const originalAfter = await getOriginalRequest({
    approvalId: id,
    workspaceId: workspace.id,
    userId: reviewer.id,
    workspaceRole: 'admin',
  })
  if (!originalAfter.ok) throw new Error(originalAfter.error)
  assert.deepEqual(originalAfter, originalBefore)

  // The amendment travels only in the read: original argsHash plus editedArgs/_meta.
  const expectedEdited = { amount: 55, currency: 'EUR' }
  const read = await getApprovalForOrigin({ apiKey: keyP1.raw, approvalId: id })
  if (!read.ok) throw new Error(read.error)
  assert.equal(read.argsHash, originalBefore.argsHash, "read's argsHash must stay the ORIGINAL args hash")
  assert.ok(read.hitl)
  assert.ok(validateResponse(read.hitl), JSON.stringify(validateResponse.errors))
  assert.equal(read.hitl.argsHash, originalBefore.argsHash)
  assert.deepEqual(read.editedArgs, expectedEdited)
  assert.deepEqual(read.hitl._meta?.['net.hitly/editedArgs'], expectedEdited)
  assert.equal(read.hitl._meta?.['net.hitly/editedArgsHash'], await jcsHash(expectedEdited))
  assert.notEqual(read.hitl._meta?.['net.hitly/editedArgsHash'], originalBefore.argsHash)
})

test('requester cancel racing a reviewer decide: exactly one winner, one decision record, loser gets 409', async () => {
  // M2 (gate pr104): the race is decided by `loadApproval(..., { forUpdate: true })`
  // on both paths. Dropping the row lock from cancelApprovalAsRequester
  // (mutant A7d) must produce double outcomes here.
  const RUNS = 16
  for (let run = 1; run <= RUNS; run++) {
    const created = await ingest(keyP1)
    const id = created.approval.id
    const jitter = Math.floor(Math.random() * 8)
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const decision = parseDecisionBody({ decision: 'accept' })
    assert.ok(decision)
    const [cancel, decide] = await Promise.all([
      wait(jitter).then(() => cancelApprovalAsRequester({ apiKey: keyP1.raw, approvalId: id })),
      wait(8 - jitter).then(() =>
        decideApproval({ approvalId: id, actorUserId: reviewer.id, payload: decision, workspaceId: workspace.id }),
      ),
    ])
    const cancelWon = cancel.ok === true
    const decideWon = 'approval' in decide
    assert.notEqual(cancelWon, decideWon, `run ${run}: exactly one of cancel/decide must win (cancelWon=${cancelWon}, decideWon=${decideWon})`)
    const loser = cancelWon ? decide : cancel
    assert.equal((loser as { status?: number }).status, 409, `run ${run}: the loser must get 409`)

    const records = await db.select().from(decisionRecords).where(eq(decisionRecords.approvalId, id))
    assert.equal(records.length, 1, `run ${run}: exactly one decision record`)
    assert.equal(records[0]?.decision, cancelWon ? 'cancel' : 'accept', `run ${run}: the winner's decision is the recorded one`)

    const [row] = await db.select().from(approvals).where(eq(approvals.id, id))
    if (cancelWon) {
      assert.equal(row?.status, 'cancelled', `run ${run}: final status must match the winner`)
    } else {
      assert.ok(
        row?.status === 'decided' || row?.status === 'failed_resume',
        `run ${run}: final status must match the winner, got ${row?.status}`,
      )
    }
  }
})

test('pending list route: the server caps the page at the published 200 even with limit=10000', async () => {
  // M3 (gate pr104): REQUESTER_PENDING_MAX_LIMIT is a claimed control; dropping
  // the server-side Math.min clamp (mutant A9) must go red here.
  assert.equal(REQUESTER_PENDING_MAX_LIMIT, 200)
  const k = await insertKey(projectP.id, 'cap key')
  const total = REQUESTER_PENDING_MAX_LIMIT + 5
  const base = Date.now()
  const rows = []
  for (let i = 0; i < total; i++) {
    rows.push({
      id: newId('apr').slice(0, 36),
      workspaceId: workspace.id,
      projectId: projectP.id,
      plugin: 'mastra' as const,
      status: 'pending' as const,
      actionName: 'pay',
      envelope: await encodeTenantJson(workspace.id, { action: { name: 'pay', args: {} } }),
      origin: await encodeTenantJson(workspace.id, { runId: `cap-${i}` }),
      requesterKeyId: k.id,
      expiresAt: new Date(base + 3_600_000),
      createdAt: new Date(base + i),
    })
  }
  await db.insert(approvals).values(rows)

  const route = await listRoute(
    new Request(`http://localhost/api/v1/approvals?projectId=${projectP.id}&limit=10000`, {
      headers: { authorization: `Bearer ${k.raw}` },
    }),
  )
  assert.equal(route.status, 200)
  const body = (await route.json()) as { status: string; items: Array<{ id: string; createdAt: string }> }
  assert.equal(body.status, 'open')
  assert.equal(body.items.length, REQUESTER_PENDING_MAX_LIMIT, `limit=10000 must be capped at ${REQUESTER_PENDING_MAX_LIMIT} server-side`)
  assert.equal(new Set(body.items.map((item) => item.id)).size, REQUESTER_PENDING_MAX_LIMIT)
  // Newest first still holds under the cap.
  assert.equal(body.items[0]?.createdAt, new Date(base + total - 1).toISOString())
})

test('create-once replay is scoped to the creating key; a sibling key gets 409 and learns nothing', async () => {
  // D3 (PM ruling): replay is per API key, consistent with key-scoped cancel
  // and list. Reverting the requesterKeyId scoping on the replay lookup
  // (mutant A4b) must go red: the sibling would replay the other key's
  // request instead of getting the conflict error.
  const idem = `idem-${newId('t')}`
  const body = payload()
  const first = await ingest(keyP1, idem, body)

  // The creating key replays its own open request, unchanged.
  const own = await ingest(keyP1, idem, body)
  assert.equal(own.replayed, true)
  assert.equal(own.approval.id, first.approval.id)

  // A sibling key on the same project gets the normal conflict error.
  const sibling = await ingestApproval({ apiKey: keyP2.raw, body: payload(), idempotencyKey: idem })
  assert.equal(sibling.ok, false)
  if (sibling.ok) throw new Error('a sibling key must not replay another key request')
  assert.equal(sibling.status, 409)
  assert.equal(typeof sibling.error, 'string')
  assert.deepEqual(Object.keys(sibling).sort(), ['error', 'ok', 'status'])
  const disclosed = JSON.stringify(sibling)
  assert.ok(!disclosed.includes(first.approval.id), 'conflict must not disclose the other approval id')
  assert.ok(!disclosed.includes('pending'), 'conflict must not disclose the other request status')

  // No second ask is created for a live id; the owner's row is untouched.
  const rows = await rowsFor(idem)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.status, 'pending')
  assert.equal(rows[0]?.requesterKeyId, keyP1.id)

  // Closed inside the window: the creating key still replays, the sibling still 409s.
  const decision = parseDecisionBody({ decision: 'accept' })
  assert.ok(decision)
  const decided = await decideApproval({ approvalId: first.approval.id, actorUserId: reviewer.id, payload: decision, workspaceId: workspace.id })
  assert.ok('approval' in decided)
  // The resume target is not running here, so settle the row as decided (closed).
  await setRow(first.approval.id, { status: 'decided' })
  const closedReplay = await ingest(keyP1, idem, body)
  assert.equal(closedReplay.replayed, true)
  assert.equal(closedReplay.approval.id, first.approval.id)
  assert.equal(closedReplay.approval.status, 'decided')
  const siblingClosed = await ingestApproval({ apiKey: keyP2.raw, body: payload(), idempotencyKey: idem })
  assert.equal(siblingClosed.ok, false)
  if (siblingClosed.ok) throw new Error('a sibling key must not replay a closed request')
  assert.equal(siblingClosed.status, 409)
  const disclosedClosed = JSON.stringify(siblingClosed)
  assert.ok(!disclosedClosed.includes(first.approval.id), 'conflict must not disclose the other approval id')
  assert.ok(!disclosedClosed.includes('decided'), 'conflict must not disclose the other request status')
  assert.equal((await rowsFor(idem)).length, 1, 'a conflicted sibling submit must not create a row')

  // Through the route: plain 409, body is the error only.
  const route = await ingestRoute(
    new Request('http://localhost/api/v1/approvals', {
      method: 'POST',
      headers: { authorization: `Bearer ${keyP2.raw}`, 'idempotency-key': idem, 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    }),
  )
  assert.equal(route.status, 409)
  assert.deepEqual(Object.keys((await route.json()) as Record<string, unknown>), ['error'])
})
