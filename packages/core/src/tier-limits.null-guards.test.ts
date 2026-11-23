/**
 * Deliberate listing of every NULL in TIER_LIMIT_SEED.
 *
 * A NULL cap means unlimited (withinLimit is always true). This file is the
 * contract pin required by hitly#181 / the #170 "every NULL is listed"
 * ruling. It does not enforce write paths; it fails only when a seed value
 * moves without an explicit product decision.
 *
 * Add this file to packages/core package.json "test".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TIER_LIMIT_SEED, TIER_LIMIT_KEYS, withinLimit, type TierLimitKey } from './index.ts'

const PLANS = ['self-hosted', 'solo', 'pro', 'team', 'enterprise'] as const

/** Plans whose seed value is NULL, listed on purpose. If you add or remove a NULL, this table is the diff. */
const NULL_PLANS: Record<TierLimitKey, readonly (typeof PLANS)[number][]> = {
  decisions_per_month: ['self-hosted', 'enterprise'],
  seats: ['self-hosted', 'enterprise'],
  live_projects: ['self-hosted', 'team', 'enterprise'],
  api_keys: ['self-hosted', 'team', 'enterprise'],
  callback_endpoints_per_project: ['self-hosted', 'enterprise'],
  // Enterprise is 3000, not unlimited.
  api_rpm: ['self-hosted'],
  // Enterprise completed retention is 1000, not unlimited.
  completed_retention_days: ['self-hosted'],
  audit_retention_days: ['self-hosted'],
}

test('every TIER_LIMIT_KEYS entry has a deliberate NULL listing', () => {
  assert.deepEqual([...TIER_LIMIT_KEYS].sort(), Object.keys(NULL_PLANS).sort())
})

test('listed NULL plans are exactly the seed NULLs (and nothing else)', () => {
  for (const key of TIER_LIMIT_KEYS) {
    const actual = PLANS.filter((plan) => TIER_LIMIT_SEED[key][plan] === null)
    assert.deepEqual(actual, [...NULL_PLANS[key]], key)
  }
})

test('api_keys and callback_endpoints_per_project numeric caps match the published seed', () => {
  assert.deepEqual(TIER_LIMIT_SEED.api_keys, {
    'self-hosted': null,
    solo: 2,
    pro: 10,
    team: null,
    enterprise: null,
  })
  assert.deepEqual(TIER_LIMIT_SEED.callback_endpoints_per_project, {
    'self-hosted': null,
    solo: 1,
    pro: 3,
    team: 10,
    enterprise: null,
  })
})

test('NULL cap is unlimited at huge usage (T3); a numeric cap refuses at usage === cap', () => {
  assert.equal(withinLimit({ status: 'ok', value: null }, 99_999), true)
  assert.equal(withinLimit({ status: 'ok', value: 2 }, 1), true)
  assert.equal(withinLimit({ status: 'ok', value: 2 }, 2), false)
  assert.equal(withinLimit({ status: 'denied', reason: 'missing_row' }, 0), false)
})
