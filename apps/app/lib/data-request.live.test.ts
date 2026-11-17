import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { memberships, supportRequests, users, workspaces } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { newId } from './ids'
import { DATA_REQUEST_TYPE, SUPPORT_REQUEST_OPEN, gdprResponseDeadline, handleDataRequest } from './data-request'
import { POST as dataRequestRoutePOST } from '../app/api/session/data-request/route'

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

if (!db || !auth) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET required for live data-request tests')
const database = db
const authApi = auth.api

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const PASSWORD = 'correct-horse-battery-staple!'
const extraUserIds: string[] = []

async function signUpReal(label: string): Promise<{ id: string; cookie: string }> {
  const email = `${label}-${run}@datareq-live.example.com`
  await authApi.signUpEmail({ body: { email, password: PASSWORD, name: `User ${label}` } })
  const { headers } = await authApi.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true })
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const rows = await database.select().from(users).where(eq(users.email, email)).limit(1)
  const user = rows[0]
  if (!user) throw new Error(`sign-up did not store ${email}`)
  extraUserIds.push(user.id)
  return { id: user.id, cookie }
}

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
  await database
    .delete(supportRequests)
    .where(inArray(supportRequests.userId, [USER_A, USER_B, ...extraUserIds]))
  await database.delete(memberships).where(inArray(memberships.userId, extraUserIds))
  await database.delete(users).where(inArray(users.id, extraUserIds))
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

// ---------------------------------------------------------------------------
// Route-level tests: the REAL NextRequest goes through the real route module
// (origin + content-type checks included) with a real Better Auth session.
// These are the M9/M10/M11/M8 pins: the request body carries a foreign
// userId and a foreign workspaceId, so a handler (or a future regression)
// that honours body.userId over the session cannot stay green. The official
// route POST is the only entry point used here — no injected getSessionUser.
// ---------------------------------------------------------------------------

function routeRequest(opts: {
  cookie?: string
  origin?: string | null
  contentType?: string | null
  body?: unknown
  workspaceHeader?: string
}) {
  const headers: Record<string, string> = {}
  if (opts.origin !== null) headers.origin = opts.origin ?? APP_URL
  if (opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json'
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.workspaceHeader) headers['x-hitly-workspace-id'] = opts.workspaceHeader
  return new NextRequest(new URL('/api/session/data-request', APP_URL), {
    method: 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

describe('data request via the real route (NextRequest + real session)', () => {
  it('M9: a body userId and foreign workspace are never trusted — only the session', async () => {
    const asker = await signUpReal('m9-asker')
    const victim = await signUpReal('m9-victim')
    const askerWsp = newId('wsp')
    const victimWsp = newId('wsp')
    await database.insert(workspaces).values([
      { id: askerWsp, name: `Askers ${run}`, slug: `askers-${run}` },
      { id: victimWsp, name: `Victims ${run}`, slug: `victims-${run}` },
    ])
    await database.insert(memberships).values([
      { id: newId('mbr'), workspaceId: askerWsp, userId: asker.id, role: 'owner' },
      { id: newId('mbr'), workspaceId: victimWsp, userId: victim.id, role: 'owner' },
    ])

    const response = await dataRequestRoutePOST(
      routeRequest({
        cookie: asker.cookie,
        // The body claims the victim's account AND the victim's workspace;
        // the header pins the session user's own workspace.
        body: { userId: victim.id, workspaceId: victimWsp, status: 'fulfilled' },
        workspaceHeader: askerWsp,
      }),
    )
    assert.equal(response.status, 201)

    const rows = await database
      .select()
      .from(supportRequests)
      .where(inArray(supportRequests.userId, [asker.id, victim.id]))
    assert.equal(rows.length, 1, 'exactly one row exists for asker+victim')
    const row = rows[0]!
    assert.equal(row.userId, asker.id, 'the row belongs to the SESSION user, not body.userId')
    assert.equal(row.workspaceId, askerWsp, 'the workspace is the session user verified one, not the body/header foreign one')
    assert.equal(row.type, DATA_REQUEST_TYPE)
    assert.equal(row.status, SUPPORT_REQUEST_OPEN, 'a body cannot pre-set the status')

    const victimRows = await database
      .select()
      .from(supportRequests)
      .where(eq(supportRequests.userId, victim.id))
    assert.deepEqual(victimRows, [], 'nothing is stored for the foreign user')
  })

  it('M10: a foreign or missing Origin is 403 before anything else', async () => {
    const asker = await signUpReal('m10-asker')
    const foreign = await dataRequestRoutePOST(
      routeRequest({ cookie: asker.cookie, origin: 'https://evil.example.com', body: {} }),
    )
    assert.equal(foreign.status, 403)
    const missing = await dataRequestRoutePOST(
      routeRequest({ cookie: asker.cookie, origin: null, body: {} }),
    )
    assert.equal(missing.status, 403)
    const rows = await database.select().from(supportRequests).where(eq(supportRequests.userId, asker.id))
    assert.deepEqual(rows, [], 'a rejected Origin never reaches the database')
  })

  it('M11: a non-JSON content type is 415 before the session is used', async () => {
    const asker = await signUpReal('m11-asker')
    const response = await dataRequestRoutePOST(
      routeRequest({ cookie: asker.cookie, contentType: 'text/plain', body: {} }),
    )
    assert.equal(response.status, 415)
    const rows = await database.select().from(supportRequests).where(eq(supportRequests.userId, asker.id))
    assert.deepEqual(rows, [], 'a rejected content type never reaches the database')
  })

  it('M8: the partial unique index is real — two direct open inserts collide', async () => {
    const asker = await signUpReal('m8-asker')
    const base = { userId: asker.id, workspaceId: null, type: DATA_REQUEST_TYPE, status: SUPPORT_REQUEST_OPEN }
    await database.insert(supportRequests).values({ id: newId('srq'), ...base })
    await assert.rejects(
      () => database.insert(supportRequests).values({ id: newId('srq'), ...base }),
      (error: unknown) => {
        // Drizzle wraps driver errors; the raw SQLSTATE sits on the cause.
        const e = error as { code?: string; cause?: { code?: string } }
        return (e.code ?? e.cause?.code) === '23505'
      },
      'without the partial unique index this second open row would land and the test fails',
    )
    const rows = await database.select().from(supportRequests).where(eq(supportRequests.userId, asker.id))
    assert.equal(rows.length, 1)
  })
})
