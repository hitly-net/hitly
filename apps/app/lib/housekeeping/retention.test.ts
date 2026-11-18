/**
 * Downgrade-safe retention window (billing plan §4).
 *
 * During the 30-day export grace after a plan change, a sweep may only
 * delete items closed AFTER the change — data the richer plan was keeping
 * stays readable/exportable. After the grace the new, shorter retention
 * applies normally. With no recorded plan change the window is exactly the
 * plain retention cutoff, so OSS behavior is unchanged.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DOWNGRADE_EXPORT_GRACE_DAYS, retentionWindow } from './jobs'

const NOW = new Date('2026-11-15T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('retentionWindow', () => {
  it('no plan change: plain retention cutoff, no floor (OSS unchanged)', () => {
    const w = retentionWindow(NOW, 10, null)
    assert.deepEqual(w.cutoff, new Date(NOW.getTime() - 10 * DAY))
    assert.equal(w.floor, null)
  })

  it('fresh downgrade: pre-downgrade items are never deleted by the sweep', () => {
    // Downgrade one hour ago; solo retention is 10 days. A closed item
    // 20 days old predates the change: the floor excludes it even though
    // it is older than the retention cutoff (the §4 "11-30 days" case).
    const changed = new Date(NOW.getTime() - 3600_000)
    const w = retentionWindow(NOW, 10, changed)
    assert.deepEqual(w.cutoff, new Date(NOW.getTime() - 10 * DAY))
    assert.deepEqual(w.floor, changed)
    const closedTwentyDaysAgo = new Date(NOW.getTime() - 20 * DAY)
    const ageEligible = closedTwentyDaysAgo < w.cutoff
    const floorEligible = !(w.floor && closedTwentyDaysAgo < w.floor)
    assert.ok(ageEligible, 'it is older than the new retention window')
    assert.ok(!floorEligible, 'the grace floor must protect it')
  })

  it('fresh downgrade: nothing can be deleted yet (floor is newer than cutoff)', () => {
    const changed = new Date(NOW.getTime() - 3600_000)
    const w = retentionWindow(NOW, 10, changed)
    assert.ok(w.floor && w.floor > w.cutoff, 'empty deletion window right after a downgrade')
  })

  it('post-downgrade items age out under the new cap once old enough', () => {
    // Downgrade 20 days ago, still inside the 30-day grace: an item closed
    // two days AFTER the downgrade (18 days old) is older than the 10-day
    // cutoff and newer than the floor: deletable.
    const changed = new Date(NOW.getTime() - 20 * DAY)
    const w = retentionWindow(NOW, 10, changed)
    assert.deepEqual(w.floor, changed)
    const closedAfterDowngrade = new Date(NOW.getTime() - 18 * DAY)
    assert.ok(closedAfterDowngrade < w.cutoff)
    assert.ok(w.floor && closedAfterDowngrade >= w.floor)
  })

  it('grace expired: the new shorter retention applies to everything', () => {
    const changed = new Date(NOW.getTime() - 400 * DAY)
    const w = retentionWindow(NOW, 10, changed)
    assert.deepEqual(w.cutoff, new Date(NOW.getTime() - 10 * DAY))
    assert.equal(w.floor, null)
  })

  it('grace boundary is inclusive at exactly 30 days', () => {
    const changed = new Date(NOW.getTime() - DOWNGRADE_EXPORT_GRACE_DAYS * DAY)
    const w = retentionWindow(NOW, 10, changed)
    assert.equal(w.floor, null, 'at the grace boundary the sweep is unrestricted again')
  })

  it('a future plan change blocks deletion entirely (floor newer than cutoff)', () => {
    const changed = new Date(NOW.getTime() + 5 * DAY)
    const w = retentionWindow(NOW, 10, changed)
    assert.ok(w.floor && w.floor > w.cutoff)
  })

  it('export grace is 30 days (billing plan §4)', () => {
    assert.equal(DOWNGRADE_EXPORT_GRACE_DAYS, 30)
  })
})
