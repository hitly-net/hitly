/**
 * Unit tests for the tier enforcement layer: gate maths (at-cap refuse vs
 * under-cap allow vs unlimited), stable refusal fields and human messages,
 * the typed action result, and the plan-appropriate upgrade path.
 * checkQuota is mocked: the DB-backed read path is pinned by
 * tier-limits.live.test.ts; the real-table wiring by tier-enforcement.live.test.ts.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'

type FakeCheck = { allowed: boolean; limit: number | null; reason?: string }
let nextCheck: FakeCheck = { allowed: true, limit: null }
const quotaCalls: Array<{ plan: string; key: string; usage: number }> = []

mock.module(new URL('./tier-limits.ts', import.meta.url).href, {
  namedExports: {
    checkQuota: async (workspace: { plan: string }, key: string, usage: number) => {
      quotaCalls.push({ plan: workspace.plan, key, usage })
      return nextCheck
    },
    limit: async () => ({ status: 'ok', value: nextCheck.limit }),
    invalidateTierLimitsCache: () => undefined,
  },
})

let tier: typeof import('./tier-enforcement')
before(async () => {
  tier = await import('./tier-enforcement')
})
beforeEach(() => {
  quotaCalls.length = 0
  nextCheck = { allowed: true, limit: null }
})

describe('gate maths (usage vs cap)', () => {
  it('under-cap new use is allowed', async () => {
    nextCheck = { allowed: true, limit: 2 }
    const result = await tier.gateMonthlyDecisions({ plan: 'solo' }, 1)
    assert.equal(result.allowed, true)
  })

  it('at-cap NEW use is refused with the stable code and a human message', async () => {
    nextCheck = { allowed: false, limit: 2, reason: 'at_limit' }
    const result = await tier.gateMonthlyDecisions({ plan: 'solo' }, 2)
    assert.equal(result.allowed, false)
    if (result.allowed) assert.fail('unreachable')
    assert.equal(result.code, 'tier_limit_reached')
    assert.equal(result.limitKey, 'decisions_per_month')
    assert.match(result.message, /Monthly decision limit reached \(2 of 2 decisions used this month\)/)
    assert.match(result.message, /Upgrade/)
  })

  it('unlimited (null) caps allow any usage', async () => {
    nextCheck = { allowed: true, limit: null }
    const result = await tier.gateSeat({ plan: 'enterprise' }, 99_999)
    assert.equal(result.allowed, true)
  })

  it('a fail-closed deny refuses with the not-available message (not the at-cap text)', async () => {
    nextCheck = { allowed: false, limit: 0, reason: 'missing_row' }
    const result = await tier.gateLiveProject({ plan: 'solo' }, 0)
    assert.equal(result.allowed, false)
    if (result.allowed) assert.fail('unreachable')
    assert.equal(result.code, 'tier_limit_reached')
    assert.equal(result.message, tier.TIER_NOT_AVAILABLE_MESSAGE)
  })

  it('each capped action checks its own key with the given usage', async () => {
    nextCheck = { allowed: true, limit: null }
    await tier.gateMonthlyDecisions({ plan: 'pro' }, 7)
    await tier.gateSeat({ plan: 'pro' }, 1)
    await tier.gateLiveProject({ plan: 'pro' }, 3)
    await tier.gateRetentionBound({ plan: 'pro' }, 11)
    assert.deepEqual(quotaCalls.map((c) => c.key), [
      'decisions_per_month',
      'seats',
      'live_projects',
      'completed_retention_days',
    ])
    assert.deepEqual(quotaCalls.map((c) => c.usage), [7, 1, 3, 11])
  })

  it('assert helpers throw the typed TierLimitError (so tenant writes roll back)', async () => {
    nextCheck = { allowed: false, limit: 2, reason: 'at_limit' }
    await assert.rejects(() => tier.assertSeat({ plan: 'solo' }, 2), (error: unknown) => {
      assert.ok(error instanceof tier.TierLimitError)
      assert.equal(error.code, 'tier_limit_reached')
      assert.equal(error.refusal.limitKey, 'seats')
      return true
    })
  })
})

describe('human messages per capped action', () => {
  it('pins the four messages', () => {
    assert.match(tier.tierLimitMessage('decisions_per_month', 300, 300), /Monthly decision limit reached \(300 of 300 decisions used this month\)/)
    assert.match(tier.tierLimitMessage('seats', 2, 2), /Seat limit reached \(2 of 2 seats in use, counting members and pending invites\)/)
    assert.match(tier.tierLimitMessage('live_projects', 2, 2), /Live project limit reached \(2 of 2 projects live at once\)/)
    assert.match(tier.tierLimitMessage('completed_retention_days', 10, 12), /12 days old — past your plan's 10-day retention/)
  })
})

describe('typed action result', () => {
  it('maps a thrown TierLimitError onto the serialisable blocked result', () => {
    const refusal = {
      code: 'tier_limit_reached' as const,
      limitKey: 'seats' as const,
      message: 'Seat limit reached…',
      limit: 2,
      usage: 2,
    }
    const mapped = tier.toTierLimitBlockedResult(new tier.TierLimitError(refusal))
    assert.deepEqual(mapped, {
      status: 'error',
      code: 'tier_limit_reached',
      limitKey: 'seats',
      message: 'Seat limit reached…',
    })
    assert.equal(tier.isTierLimitBlockedResult(mapped), true)
    assert.equal(tier.isTierLimitBlockedResult({ status: 'error', code: 'email_not_verified', message: 'x' }), false)
    assert.equal(tier.toTierLimitBlockedResult(new Error('plain')), null)
  })
})

describe('upgrade path by plan', () => {
  it('Free and Pro link to the /signup billing entry', () => {
    assert.deepEqual(tier.upgradeHint('solo'), { label: 'Upgrade', href: '/signup' })
    assert.deepEqual(tier.upgradeHint('pro'), { label: 'Upgrade', href: '/signup' })
  })
  it('Team and Enterprise show the pricing contact path', () => {
    assert.deepEqual(tier.upgradeHint('team'), { label: 'Contact us', href: 'mailto:hello@hitly.net' })
    assert.deepEqual(tier.upgradeHint('enterprise'), { label: 'Contact us', href: 'mailto:hello@hitly.net' })
  })
  it('self-hosted (unlimited OSS) has no upgrade path', () => {
    assert.equal(tier.upgradeHint('self-hosted'), null)
    assert.equal(tier.upgradeHint(''), null)
  })
})

describe('tierUsageFor (limit/usage display)', () => {
  it('reports usage, cap and reached when at the cap, with the upgrade hint', async () => {
    nextCheck = { allowed: false, limit: 2, reason: 'at_limit' }
    const usage = await tier.tierUsageFor({ plan: 'solo' }, 'seats', 2)
    assert.deepEqual(usage, {
      limitKey: 'seats',
      usage: 2,
      limit: 2,
      reached: true,
      upgrade: { label: 'Upgrade', href: '/signup' },
    })
  })
  it('not reached under the cap; unlimited shows null limit', async () => {
    nextCheck = { allowed: true, limit: 10 }
    const usage = await tier.tierUsageFor({ plan: 'pro' }, 'live_projects', 1)
    assert.equal(usage.reached, false)
    assert.equal(usage.limit, 10)
  })
})

describe('retentionAgeDays', () => {
  it('floors whole days and never goes negative', () => {
    const now = Date.UTC(2026, 10, 18, 12, 0, 0)
    const DAY = 24 * 60 * 60 * 1000
    assert.equal(tier.retentionAgeDays(new Date(now - 2 * DAY - 60_000), now), 2)
    assert.equal(tier.retentionAgeDays(new Date(now + DAY), now), 0)
    assert.equal(tier.retentionAgeDays(new Date(now - DAY), now), 1)
  })
})

describe('ENFORCED_TIER_LIMIT_KEYS', () => {
  it('claims every key this build actually gates, including api_keys', () => {
    for (const key of [
      'decisions_per_month',
      'seats',
      'live_projects',
      'completed_retention_days',
      'api_keys',
    ] as const) {
      assert.ok(
        (tier.ENFORCED_TIER_LIMIT_KEYS as readonly string[]).includes(key),
        `${key} must be listed in ENFORCED_TIER_LIMIT_KEYS so clients can pre-flight it`,
      )
    }
  })
})
