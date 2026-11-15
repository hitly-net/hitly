import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { memberships, supportRequests } from '@hitly/db/schema'
import { gdprResponseDeadline, handleDataRequest } from './data-request'
import { createRateLimiter } from './reset-check-limit'

/**
 * Unit tests for the "Request my data" capture endpoint: session-before-
 * limiter ordering, the per-account rate limit, the idempotent insert (open
 * row returned unchanged, insert race resolved to the winner), the
 * membership-verified workspace and the UK GDPR one-month deadline math.
 * A hand-rolled fake database answers every select by table and emulates
 * the partial unique index (one open row per user+type); the live run
 * against real Postgres is lib/data-request.live.test.ts.
 *
 * Mutation notes (each mutant turns one test RED):
 * - Read the body for userId/workspaceId -> the forged-body test sees the
 *   other account's id in the inserted row.
 * - Skip the membership check and trust the header/cookie -> the foreign-
 *   workspace tests record a workspace the user is not a member of.
 * - Drop the pre-insert open check -> the idempotency test inserts a second
 *   row; drop the P23505 catch -> the race test answers 500.
 * - Answer the limiter before the session check -> the 401 test sees 429.
 * - Add 30 days instead of one calendar month -> the end-of-month clamp
 *   tests fail (Jan 31 must be Feb 28/29, not Mar 2/3).
 */

type Row = Record<string, unknown>

const USER_ID = 'usr_request_owner'
const OTHER_ID = 'usr_other_account'
const MY_WSP = 'wsp_member_mine'
const FOREIGN_WSP = 'wsp_member_not_mine'

/** Bound parameter values inside a drizzle where/join expression, in order.
 * Only drizzle `Param` nodes count — StringChunk fragments (parens, ' = ')
 * also carry a `value` array and must be skipped. */
function sqlParams(node: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (n: unknown) => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n !== 'object') return
    const record = n as Record<string, unknown>
    if (Array.isArray(record.queryChunks)) return walk(record.queryChunks)
    if ('value' in record && 'encoder' in record) out.push(record.value)
  }
  walk(node)
  return out
}

interface FakeState {
  requests: Row[]
  members: Array<{ userId: string; workspaceId: string }>
  failInsertWith?: unknown
  /** When set, the first insert throws the unique violation (concurrent
   * click); only after that may the select answer with this winner row. */
  raceWinner?: Row
}

function fakeDatabase(state: FakeState) {
  const inserts: Row[] = []
  const reads: unknown[] = []
  let raceConsumed = false
  const chain = (table: unknown) => {
    const params: unknown[] = []
    const self: Record<string, unknown> = {
      innerJoin: () => self,
      where: (condition: unknown) => {
        params.push(...sqlParams(condition))
        return self
      },
      limit: async (n: number) => {
        reads.push(table)
        if (table === supportRequests) {
          const [userId, type, status] = params
          const matches = state.requests.filter(
            (row) => row.userId === userId && row.type === type && row.status === status,
          )
          if (matches.length === 0 && raceConsumed && state.raceWinner) {
            return [state.raceWinner].slice(0, n)
          }
          return matches.slice(0, n)
        }
        if (table === memberships) {
          const [userId, workspaceId] = params
          return state.members.filter((m) => m.userId === userId && m.workspaceId === workspaceId).slice(0, n)
        }
        return []
      },
    }
    return self
  }
  return {
    inserts,
    reads,
    db: {
      select: () => ({ from: (table: unknown) => chain(table) }) as never,
      insert: (table: unknown) => ({
        values: async (row: Row) => {
          if (table !== supportRequests) throw new Error(`unexpected insert into ${String(table)}`)
          if (state.failInsertWith !== undefined) {
            const error = state.failInsertWith
            state.failInsertWith = undefined
            throw error
          }
          if (state.raceWinner && !raceConsumed) {
            raceConsumed = true
            throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
          }
          if (
            state.requests.some(
              (existing) =>
                existing.userId === row.userId && existing.type === row.type && existing.status === 'open',
            )
          ) {
            throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
          }
          inserts.push({ ...row })
        },
      }),
    } as never,
  }
}

function headersWith(extra: Record<string, string> = {}): Headers {
  return new Headers(extra)
}

describe('data request capture (fake db)', () => {
  it('401s an anonymous caller before the limiter or the database', async () => {
    const fake = fakeDatabase({ requests: [], members: [] })
    const allowKeys: string[] = []
    const response = await handleDataRequest(
      { headers: headersWith() },
      {
        getSessionUser: async () => null,
        database: fake.db,
        allow: (key) => {
          allowKeys.push(key)
          return true
        },
        log: () => {},
      },
    )
    assert.equal(response.status, 401)
    assert.deepEqual(allowKeys, [])
    assert.deepEqual(fake.reads, [])
    assert.deepEqual(fake.inserts, [])
  })

  it('500s when the session lookup itself fails', async () => {
    const fake = fakeDatabase({ requests: [], members: [] })
    const response = await handleDataRequest(
      { headers: headersWith() },
      {
        getSessionUser: async () => {
          throw new Error('boom')
        },
        database: fake.db,
        log: () => {},
      },
    )
    assert.equal(response.status, 500)
  })

  it('rate limits per account with 429 + Retry-After and no second insert', async () => {
    const fake = fakeDatabase({ requests: [], members: [{ userId: USER_ID, workspaceId: MY_WSP }] })
    const limiter = createRateLimiter({ limit: 1, windowMs: 60 * 60 * 1000 })
    const deps = {
      getSessionUser: async () => ({ id: USER_ID }),
      database: fake.db,
      allow: limiter,
      log: () => {},
    }
    const first = await handleDataRequest({ headers: headersWith() }, deps)
    assert.equal(first.status, 201)
    const second = await handleDataRequest({ headers: headersWith() }, deps)
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), String(60 * 60))
    assert.equal(fake.inserts.length, 1)
    // Buckets are keyed per user: another account is unaffected.
    const other = await handleDataRequest(
      { headers: headersWith() },
      { ...deps, getSessionUser: async () => ({ id: OTHER_ID }) },
    )
    assert.equal(other.status, 201)
  })

  it('creates one open data request from the session alone — the body is never read', async () => {
    const fake = fakeDatabase({ requests: [], members: [{ userId: USER_ID, workspaceId: MY_WSP }] })
    const response = await handleDataRequest(
      { headers: headersWith({ 'x-hitly-workspace-id': MY_WSP }) },
      {
        getSessionUser: async () => ({ id: USER_ID }),
        database: fake.db,
        allow: () => true,
        log: () => {},
        now: () => new Date('2026-11-15T09:00:00.000Z'),
      },
    )
    assert.equal(response.status, 201)
    const body = (await response.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(body).sort(), ['requestedAt', 'responseBy', 'status'])
    assert.equal(body.status, 'open')
    assert.equal(body.requestedAt, '2026-11-15T09:00:00.000Z')
    assert.equal(body.responseBy, '2026-12-15T09:00:00.000Z')
    assert.equal(fake.inserts.length, 1)
    const row = fake.inserts[0]
    assert.equal(row.userId, USER_ID)
    assert.equal(row.workspaceId, MY_WSP)
    assert.equal(row.type, 'data')
    assert.equal(row.status, 'open')
    // Even if a caller smuggled ids into the body, nothing here can pick them up.
    assert.equal(JSON.stringify(row).includes(OTHER_ID), false)
    assert.equal(JSON.stringify(row).includes(FOREIGN_WSP), false)
  })

  it('records no workspace when the header names a foreign workspace', async () => {
    const fake = fakeDatabase({ requests: [], members: [{ userId: USER_ID, workspaceId: MY_WSP }] })
    const response = await handleDataRequest(
      { headers: headersWith({ 'x-hitly-workspace-id': FOREIGN_WSP }) },
      { getSessionUser: async () => ({ id: USER_ID }), database: fake.db, allow: () => true, log: () => {} },
    )
    assert.equal(response.status, 201)
    assert.equal(fake.inserts[0].workspaceId, null)
  })

  it('honours the workspace cookie but only after the membership check', async () => {
    const trusted = fakeDatabase({ requests: [], members: [{ userId: USER_ID, workspaceId: MY_WSP }] })
    const ok = await handleDataRequest(
      { headers: headersWith({ cookie: `hitly-workspace-id=${MY_WSP}; other=1` }) },
      { getSessionUser: async () => ({ id: USER_ID }), database: trusted.db, allow: () => true, log: () => {} },
    )
    assert.equal(ok.status, 201)
    assert.equal(trusted.inserts[0].workspaceId, MY_WSP)

    const forged = fakeDatabase({ requests: [], members: [{ userId: USER_ID, workspaceId: MY_WSP }] })
    const denied = await handleDataRequest(
      { headers: headersWith({ cookie: `hitly-workspace-id=${FOREIGN_WSP}` }) },
      { getSessionUser: async () => ({ id: USER_ID }), database: forged.db, allow: () => true, log: () => {} },
    )
    assert.equal(denied.status, 201)
    assert.equal(forged.inserts[0].workspaceId, null)
  })

  it('is idempotent: an open request is returned unchanged, nothing inserted', async () => {
    const requestedAt = new Date('2026-11-10T08:00:00.000Z')
    const fake = fakeDatabase({
      requests: [{ id: 'srq_open', userId: USER_ID, workspaceId: MY_WSP, type: 'data', status: 'open', createdAt: requestedAt }],
      members: [],
    })
    const response = await handleDataRequest(
      { headers: headersWith({ 'x-hitly-workspace-id': MY_WSP }) },
      { getSessionUser: async () => ({ id: USER_ID }), database: fake.db, allow: () => true, log: () => {} },
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.requestedAt, requestedAt.toISOString())
    assert.equal(body.responseBy, '2026-12-10T08:00:00.000Z')
    assert.deepEqual(fake.inserts, [])
  })

  it('a fulfilled request does not block a fresh one', async () => {
    const fake = fakeDatabase({
      requests: [{ id: 'sreq_done', userId: USER_ID, workspaceId: null, type: 'data', status: 'fulfilled', createdAt: new Date() }],
      members: [],
    })
    const response = await handleDataRequest(
      { headers: headersWith() },
      { getSessionUser: async () => ({ id: USER_ID }), database: fake.db, allow: () => true, log: () => {} },
    )
    assert.equal(response.status, 201)
    assert.equal(fake.inserts.length, 1)
  })

  it('resolves a concurrent insert race to the winner row (200, no second row)', async () => {
    const winnerCreatedAt = new Date('2026-11-15T09:30:00.000Z')
    const fake = fakeDatabase({
      requests: [],
      members: [{ userId: USER_ID, workspaceId: MY_WSP }],
      raceWinner: { id: 'srq_winner', userId: USER_ID, workspaceId: MY_WSP, type: 'data', status: 'open', createdAt: winnerCreatedAt },
    })
    const response = await handleDataRequest(
      { headers: headersWith({ 'x-hitly-workspace-id': MY_WSP }) },
      { getSessionUser: async () => ({ id: USER_ID }), database: fake.db, allow: () => true, log: () => {} },
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.requestedAt, winnerCreatedAt.toISOString())
    assert.deepEqual(fake.inserts, [])
  })

  it('a non-uniqueness insert failure answers 500', async () => {
    const fake = fakeDatabase({
      requests: [],
      members: [{ userId: USER_ID, workspaceId: MY_WSP }],
      failInsertWith: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    })
    const response = await handleDataRequest(
      { headers: headersWith() },
      { getSessionUser: async () => ({ id: USER_ID }), database: fake.db, allow: () => true, log: () => {} },
    )
    assert.equal(response.status, 500)
  })
})

describe('UK GDPR one-month deadline', () => {
  const at = (iso: string) => new Date(iso)
  const deadline = (iso: string) => gdprResponseDeadline(at(iso)).toISOString()

  it('is the same calendar day of the next month, time preserved', () => {
    assert.equal(deadline('2026-11-15T09:00:00.000Z'), '2026-12-15T09:00:00.000Z')
    assert.equal(deadline('2026-05-01T23:59:59.999Z'), '2026-06-01T23:59:59.999Z')
  })

  it('clamps to the last day when the day-of-month does not exist', () => {
    assert.equal(deadline('2026-01-31T10:00:00.000Z'), '2026-02-28T10:00:00.000Z')
    assert.equal(deadline('2024-01-31T10:00:00.000Z'), '2024-02-29T10:00:00.000Z')
    assert.equal(deadline('2026-10-31T10:00:00.000Z'), '2026-11-30T10:00:00.000Z')
    assert.equal(deadline('2026-03-31T10:00:00.000Z'), '2026-04-30T10:00:00.000Z')
  })
})
