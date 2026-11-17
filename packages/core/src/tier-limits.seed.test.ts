/**
 * Pinned tier seed (PM ruling, pricing-config single source).
 *
 * These are the contract numbers: Free (plan id solo) 300 decisions / 2
 * seats / 10-day completed retention, Pro 2 500 / 3 / 30, Team 20 000 / 10
 * seats / 90-day completed retention, Enterprise custom (null caps) with a
 * 1000-day completed-retention window (custom only via contract later;
 * there is deliberately no never-purge tier). Audit retention stays at the
 * fixed product values — Team audit is 365 days regardless of the completed
 * window change. Both TIER_LIMIT_SEED and COMPLETED_RETENTION_DAYS derive
 * from pricing.ts (PRICING_LIMITS), so this test pins the derivation AND the
 * literals it must produce: a change to the pricing config lands here loudly.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPLETED_RETENTION_DAYS,
  PRICING_LIMITS,
  TIER_LIMIT_SEED,
} from './index.ts'

test('Free (solo): 300 decisions / 2 seats / 10-day completed retention', () => {
  assert.equal(TIER_LIMIT_SEED.decisions_per_month.solo, 300)
  assert.equal(TIER_LIMIT_SEED.seats.solo, 2)
  assert.equal(TIER_LIMIT_SEED.completed_retention_days.solo, 10)
  assert.equal(COMPLETED_RETENTION_DAYS.solo, 10)
})

test('Pro: 2500 decisions / 3 seats / 30-day completed retention', () => {
  assert.equal(TIER_LIMIT_SEED.decisions_per_month.pro, 2500)
  assert.equal(TIER_LIMIT_SEED.seats.pro, 3)
  assert.equal(TIER_LIMIT_SEED.completed_retention_days.pro, 30)
  assert.equal(COMPLETED_RETENTION_DAYS.pro, 30)
})

test('Team: 20000 decisions / 10 seats / 90-day completed retention', () => {
  assert.equal(TIER_LIMIT_SEED.decisions_per_month.team, 20000)
  assert.equal(TIER_LIMIT_SEED.seats.team, 10)
  assert.equal(TIER_LIMIT_SEED.completed_retention_days.team, 90)
  assert.equal(COMPLETED_RETENTION_DAYS.team, 90)
})

test('Enterprise: custom caps with a 1000-day completed-retention window', () => {
  assert.equal(TIER_LIMIT_SEED.decisions_per_month.enterprise, null)
  assert.equal(TIER_LIMIT_SEED.seats.enterprise, null)
  assert.equal(TIER_LIMIT_SEED.completed_retention_days.enterprise, 1000)
  assert.equal(COMPLETED_RETENTION_DAYS.enterprise, 1000)
  // 1000 days is finite: there is no never-purge tier for completed items.
  assert.ok(TIER_LIMIT_SEED.completed_retention_days.enterprise > 0)
})

test('audit retention is unchanged by the ruling (Team stays 365)', () => {
  assert.equal(TIER_LIMIT_SEED.audit_retention_days.team, 365)
  assert.equal(TIER_LIMIT_SEED.audit_retention_days.solo, 30)
  assert.equal(TIER_LIMIT_SEED.audit_retention_days.pro, 365)
  assert.equal(TIER_LIMIT_SEED.audit_retention_days.enterprise, 2555)
})

test('the seed values are the pricing config values (single source)', () => {
  for (const plan of ['solo', 'pro', 'team'] as const) {
    assert.equal(TIER_LIMIT_SEED.decisions_per_month[plan], PRICING_LIMITS[plan].decisionsPerMonth)
    assert.equal(TIER_LIMIT_SEED.seats[plan], PRICING_LIMITS[plan].seats)
    assert.equal(
      TIER_LIMIT_SEED.completed_retention_days[plan],
      PRICING_LIMITS[plan].retentionDays,
    )
    assert.equal(COMPLETED_RETENTION_DAYS[plan], PRICING_LIMITS[plan].retentionDays)
  }
})
