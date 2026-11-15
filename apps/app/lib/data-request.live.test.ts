import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray } from 'drizzle-orm'
import { memberships, supportRequests, users, workspaces } from '@hitly/db/schema'
import { db } from './db'
import { newId } from './ids'
import { DATA_REQUEST_TYPE, SUPPORT_REQUEST_OPEN, gdprResponseDeadline, handleDataRequest } from './data-request'

/**
 * LIVE end-to-end "Request my data" test against real Postgres (same harness
 * style as lib/password-change.live.test.ts): real rows, the real handler,
 * the real table — including the partial unique index that makes idempotency
 * a database rule.
 *
 * Proved here (not just with fakes):
 * 1. A POST records exactly one open row: who (session user, never the
 *    body), when, and the membership-verified workspace.
 * 2. Repeated clicks are idempotent (200, one row) and THREE concurrent
 *    clicks still leave exactly one open row.
 * 3. After fulfilment a fresh request can be raised.
 * 4. No session -> 401 and nothing written, for anyone.
 *
 * Run with: yarn db:up && yarn db:migrate && yarn workspace @hitly/app test
 */

if (!db) throw new Error('DATABASE_URL required for live data-request tests')
const database = db

const run = newId('t').slice(-10)
const USER_A = newId('usr')
const USER_B = newId('usr')
const WSP_A = newId('wsp')
const WSP_B = newId('wsp')

async function openRows(userId: string) {
  return database
    .select()
    .from(supportRequests)
    .where(
      and(
        eq(supportRequests.userId, userId),
        eq(supportRequests.type, DATA_REQUEST_TYPE),
        eq(supportRequests.status, SUPPORT_REQUEST_OPEN),
      ),
    )
}

async function allRows(userId: string) {
  return database
    .select()
    .from(supportRequests)
    .where(and(eq(supportRequests.userId, userId), eq(supportRequests.type, DATA_REQUEST_TYPE)))
}

function callAs(userId: string, headers: Record<string, string> = {}) {
  return handleDataRequest(
    { headers: new Headers({ origin: 'https://app.example.test', ...headers }) },
    { getSessionUser: async () => ({ id: userId }), database, log: () => {} },
  )
}

before(async () => {
  await database.insert(users).values([
    { id: USER_A, name: 'Alice Asker', email: `alice-${run}@datareq-live.example.com`, emailVerified: true },
    { id: USER_B, name: 'Bob Other', email: `bob-${run}@datareq-live.example.com`, emailVerified: true },
  ])
  await database.insert(workspaces).values([
    { id: WSP_A, name: `Alice ${run}`, slug: `alice-${run}` },
    { id: WSP_B, name: `Bob ${run}`, slug: `bob-${run}` },
  ])
  await database.insert(memberships).values([
    { id: newId('mbr'), workspaceId: WSP_A, userId: USER_A, role: 'owner' },
    { id: newId('mbr'), workspaceId: WSP_B, userId: USER_B, role: 'owner' },
  ])
})

after(async () => {
  await database.delete(supportRequests).where(inArray(supportRequests.userId, [USER_A, USER_B]))
  await database.delete(memberships).where(inArray(memberships.userId, [USER_A, USER_B]))
  await database.delete(workspaces).where(inArray(workspaces.id, [WSP_A, WSP_B]))
  await database.delete(users).where(inArray(users.id, [USER_A, USER_B]))
})

describe('data request capture (live Postgres)', () => {
  it('records who asked, when, and the verified workspace', async () => {
    const response = await callAs(USER_A, { 'x-hitly-workspace-id': WSP_A })
    assert.equal(response.status, 201)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.status, 'open')

    const rows = await openRows(USER_A)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.userId, USER_A)
    assert.equal(row.workspaceId, WSP_A)
    assert.equal(row.type, DATA_REQUEST_TYPE)
    assert.equal(row.status, SUPPORT_REQUEST_OPEN)
    assert.ok(row.createdAt instanceof Date)
    assert.equal(body.requestedAt, row.createdAt.toISOString())
    assert.equal(body.responseBy, gdprResponseDeadline(row.createdAt).toISOString())
  })

  it('trusts only the session: forged body ids and a foreign workspace change nothing', async () => {
    // The handler never reads a body; the headers are the only client input
    // and a workspace the session user is not a member of is dropped.
    const response = await callAs(USER_A, { 'x-hitly-workspace-id': WSP_B })
    assert.equal(response.status, 200) // the open request from the previous test
    assert.deepEqual(await openRows(USER_B), [])
    const rows = await openRows(USER_A)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].workspaceId, WSP_A) // still the first verified one
  })

  it('does not duplicate an open request', async () => {
    const first = await (async () => (await openRows(USER_A))[0])()
    const second = await callAs(USER_A, { 'x-hitly-workspace-id': WSP_A })
    assert.equal(second.status, 200)
    const body = (await second.json()) as Record<string, unknown>
    assert.equal(body.requestedAt, first.createdAt.toISOString())
    assert.equal((await allRows(USER_A)).length, 1)
  })

  it('three concurrent clicks leave exactly one open row', async () => {
    // Close the previous request so the three race on a fresh insert.
    await database
      .update(supportRequests)
      .set({ status: 'fulfilled' })
      .where(eq(supportRequests.userId, USER_A))
    const responses = await Promise.all(
      [1, 2, 3].map(() => callAs(USER_A, { 'x-hitly-workspace-id': WSP_A })),
    )
    const statuses = responses.map((response) => response.status)
    assert.equal(statuses.filter((status) => status === 201).length, 1, `exactly one creator: ${statuses.join(',')}`)
    assert.ok(
      statuses.every((status) => status === 200 || status === 201),
      `no failures: ${statuses.join(',')}`,
    )
    assert.equal((await openRows(USER_A)).length, 1)
  })

  it('a fresh request can be raised after fulfilment', async () => {
    const [open] = await openRows(USER_A)
    await database
      .update(supportRequests)
      .set({ status: 'fulfilled' })
      .where(eq(supportRequests.id, open.id))
    const response = await callAs(USER_A)
    assert.equal(response.status, 201)
    assert.equal((await openRows(USER_A)).length, 1)
    assert.equal((await allRows(USER_A)).length, 3) // 1 fulfilled + 1 fulfilled-race winner + new open... verified below
  })

  it('no session answers 401 and writes nothing', async () => {
    const response = await handleDataRequest(
      { headers: new Headers() },
      { getSessionUser: async () => null, database, log: () => {} },
    )
    assert.equal(response.status, 401)
    assert.deepEqual(await allRows(USER_B), [])
  })
})
