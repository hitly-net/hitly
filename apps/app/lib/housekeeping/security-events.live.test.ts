/**
 * LIVE tests for the security-event retention sweep.
 *
 * The account-deletion ruling is: keep security events for a retention window
 * with the identity replaced by HMACs, THEN forget them. These tests drive the
 * real sweep against Postgres and pin the two ways it must never over-delete:
 * a row still attached to a user, and a row that was never given a deadline.
 */

process.env.HITLY_MAIL_TRANSPORT = 'memory'

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray } from 'drizzle-orm'
import { accountSecurityEvents, users } from '@hitly/db/schema'
import { db } from '../db'
import { newId } from '../ids'
import { purgeExpiredSecurityEvents } from './security-events'

if (!db) throw new Error('DATABASE_URL required for tests')
const database = db

const created: string[] = []
const createdUsers: string[] = []

function row(overrides: Partial<typeof accountSecurityEvents.$inferInsert>) {
  const id = newId('sec').slice(0, 36)
  created.push(id)
  return { id, ...overrides }
}

after(async () => {
  await database.delete(accountSecurityEvents).where(inArray(accountSecurityEvents.id, created))
  if (createdUsers.length > 0) await database.delete(users).where(inArray(users.id, createdUsers))
})

describe('security-event retention sweep', () => {
  it('deletes only anonymised rows past their deadline', async () => {
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const expiredAnonymised = row({
      userId: null,
      userIdHmac: 'a'.repeat(64),
      emailHmac: 'b'.repeat(64),
      ipTruncated: '203.0.113.0',
      type: 'mfa_enabled',
      retentionExpiresAt: past,
    })
    const freshAnonymised = row({
      userId: null,
      userIdHmac: 'c'.repeat(64),
      emailHmac: 'd'.repeat(64),
      type: 'account_deleted',
      retentionExpiresAt: future,
    })
    const neverDated = row({ userId: null, type: 'legacy_row' })
    const holderId = newId('usr').slice(0, 36)
    await database.insert(users).values({ id: holderId, name: 'Holder', email: `holder-${holderId}@housekeeping.example.test` })
    createdUsers.push(holderId)
    const liveUser = row({
      userId: holderId,
      type: 'mfa_enabled',
      retentionExpiresAt: past,
    })
    await database.insert(accountSecurityEvents).values([
      expiredAnonymised,
      freshAnonymised,
      neverDated,
      liveUser,
    ] as (typeof accountSecurityEvents.$inferInsert)[])

    const { deleted } = await purgeExpiredSecurityEvents()
    assert.ok(deleted >= 1, `expected at least one sweep, deleted ${deleted}`)

    const survivors = await database
      .select({ id: accountSecurityEvents.id })
      .from(accountSecurityEvents)
      .where(inArray(accountSecurityEvents.id, created))
    const ids = survivors.map((item) => item.id)
    assert.ok(!ids.includes(expiredAnonymised.id), 'the expired anonymised row must be swept')
    assert.ok(ids.includes(freshAnonymised.id), 'an anonymised row still inside its window survives')
    assert.ok(ids.includes(neverDated.id), 'a row without a deadline was never anonymised by a deletion; keep it')
    assert.ok(ids.includes(liveUser.id), 'a row still attached to a user is never swept')

    await database.delete(accountSecurityEvents).where(eq(accountSecurityEvents.id, liveUser.id))
  })

  it('is a no-op when nothing has expired', async () => {
    const future = row({
      userId: null,
      userIdHmac: 'e'.repeat(64),
      emailHmac: 'f'.repeat(64),
      type: 'account_deleted',
      retentionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    await database.insert(accountSecurityEvents).values([future] as (typeof accountSecurityEvents.$inferInsert)[])
    const { deleted } = await purgeExpiredSecurityEvents({ now: () => Date.now() - 48 * 60 * 60 * 1000 })
    assert.equal(deleted, 0)
  })

  it('keeps a row whose deadline is exactly the sweep instant (strict boundary)', async () => {
    // The purge deletes only rows STRICTLY past their deadline. A row whose
    // retention_expires_at equals the sweep instant has not expired yet and
    // must survive, while a row one millisecond earlier must go. Pins the
    // boundary against an off-by-one (lt -> lte) regression.
    const instant = Math.floor(Date.now() / 1000) * 1000
    const atDeadline = row({
      userId: null,
      userIdHmac: 'a'.repeat(64),
      emailHmac: 'b'.repeat(64),
      type: 'account_deleted',
      retentionExpiresAt: new Date(instant),
    })
    const justPast = row({
      userId: null,
      userIdHmac: 'c'.repeat(64),
      emailHmac: 'd'.repeat(64),
      type: 'account_deleted',
      retentionExpiresAt: new Date(instant - 1),
    })
    await database.insert(accountSecurityEvents).values([
      atDeadline,
      justPast,
    ] as (typeof accountSecurityEvents.$inferInsert)[])

    const { deleted } = await purgeExpiredSecurityEvents({ now: () => instant })
    assert.ok(deleted >= 1, `the strictly-past row must be swept, deleted ${deleted}`)

    const survivors = await database
      .select({ id: accountSecurityEvents.id })
      .from(accountSecurityEvents)
      .where(inArray(accountSecurityEvents.id, [atDeadline.id, justPast.id]))
    const ids = survivors.map((item) => item.id)
    assert.ok(ids.includes(atDeadline.id), 'a row expiring exactly at the sweep instant is NOT yet expired')
    assert.ok(!ids.includes(justPast.id), 'a row one millisecond past must be swept')
  })
})
