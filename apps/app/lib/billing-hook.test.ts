/**
 * Billing hook (edition.billing) contract tests.
 *
 * The OSS edition must never report a paid subscription and must never
 * claim a plan history. The app-side wrapper fails closed against
 * destructive use: a missing seam is "no subscription" (OSS truth), but a
 * throwing seam is "subscription exists" / "plan just changed" so a broken
 * Cloud hook can neither delete a paying workspace nor let a retention
 * sweep destroy data.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { edition } from '@hitly/cloud'
import { getPlanChangedAt, hasActivePaidSubscription } from './billing'

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.warn = original) }
}

describe('OSS billing stub', () => {
  it('never reports an active paid subscription', async () => {
    assert.equal(await hasActivePaidSubscription('ws_whatever'), false)
  })

  it('has no plan-change history', async () => {
    assert.equal(await getPlanChangedAt('ws_whatever'), null)
  })
})

describe('wrapper fail-closed policy', () => {
  it('a throwing hook is treated as "subscription exists"', async () => {
    const original = edition.billing
    try {
      edition.billing = {
        async hasActivePaidSubscription() {
          throw new Error('billing table unreachable')
        },
        async getPlanChangedAt() {
          return null
        },
      }
      const cap = captureWarnings()
      try {
        assert.equal(await hasActivePaidSubscription('ws_paying'), true)
        assert.equal(cap.lines.length, 1)
        assert.match(cap.lines[0], /\[hitly billing\]/)
        assert.doesNotMatch(cap.lines[0], /ws_paying|unreachable/, 'logs stay value-free')
      } finally {
        cap.restore()
      }
    } finally {
      edition.billing = original
    }
  })

  it('a throwing plan-change hook protects the retention window', async () => {
    const original = edition.billing
    try {
      edition.billing = {
        async hasActivePaidSubscription() {
          return false
        },
        async getPlanChangedAt() {
          throw new Error('billing table unreachable')
        },
      }
      const before = Date.now()
      const changed = await getPlanChangedAt('ws_any')
      assert.ok(changed instanceof Date)
      assert.ok(changed!.getTime() >= before && changed!.getTime() <= Date.now())
    } finally {
      edition.billing = original
    }
  })

  it('an edition without the seam behaves like OSS', async () => {
    const original = edition.billing
    try {
      delete edition.billing
      assert.equal(await hasActivePaidSubscription('ws_any'), false)
      assert.equal(await getPlanChangedAt('ws_any'), null)
    } finally {
      edition.billing = original
    }
  })

  it('a healthy overlay implementation is surfaced unchanged', async () => {
    const original = edition.billing
    const when = new Date('2026-11-01T00:00:00.000Z')
    try {
      edition.billing = {
        async hasActivePaidSubscription() {
          return true
        },
        async getPlanChangedAt() {
          return when
        },
      }
      assert.equal(await hasActivePaidSubscription('ws_paid'), true)
      assert.equal(await getPlanChangedAt('ws_paid'), when)
    } finally {
      edition.billing = original
    }
  })
})
