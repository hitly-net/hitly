/**
 * Pins the single pricing config to the approved GA values.
 * If a value here changes, both pricing surfaces change — this test is the
 * contract. Run with: yarn workspace @hitly/core test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PRICING_CONTACT_EMAIL,
  PRICING_CURRENCIES,
  PRICING_INTERVALS,
  PRICING_LIMITS,
  PRICING_TIERS,
  PRICING_VAT_NOTE,
  decisionsLabel,
  formatPricingAmount,
  isPurchasablePlan,
  priceDisplay,
  priceNoteFor,
  priceSuffixFor,
  pricingIntervalSuffix,
  pricingTier,
  retentionDisplayFor,
  retentionLabel,
  seatsLabel,
  stripeLookupKey,
} from './pricing.ts'

test('tiers: four tiers in display order with pinned labels', () => {
  assert.deepEqual(
    PRICING_TIERS.map((t) => t.id),
    ['solo', 'pro', 'team', 'enterprise'],
  )
  assert.deepEqual(
    PRICING_TIERS.map((t) => t.label),
    ['Free', 'Pro', 'Team', 'Enterprise'],
  )
  // Display label "Free" for plan id `solo` (DB plan value stays `solo`).
  assert.equal(pricingTier('solo')?.id, 'solo')
  assert.equal(pricingTier('solo')?.label, 'Free')
})

test('prices: every currency and interval is pinned', () => {
  assert.deepEqual([...PRICING_CURRENCIES], ['gbp', 'usd'])
  assert.deepEqual([...PRICING_INTERVALS], ['monthly', 'annual'])

  const expected: Record<string, Record<string, Record<string, number | null>>> = {
    solo: { monthly: { gbp: 0, usd: 0 }, annual: { gbp: 0, usd: 0 } },
    pro: { monthly: { gbp: 15, usd: 19 }, annual: { gbp: 144, usd: 180 } },
    team: { monthly: { gbp: 65, usd: 79 }, annual: { gbp: 624, usd: 756 } },
    enterprise: { monthly: { gbp: null, usd: null }, annual: { gbp: 750, usd: 950 } },
  }
  for (const tier of PRICING_TIERS) {
    assert.deepEqual(tier.prices, expected[tier.id], `prices for ${tier.id}`)
  }
})

test('price display strings match the approved copy', () => {
  // Free is 0 in both currencies.
  assert.equal(priceDisplay('solo', 'monthly', 'gbp'), '£0')
  assert.equal(priceDisplay('solo', 'monthly', 'usd'), '$0')
  // Pro monthly.
  assert.equal(priceDisplay('pro', 'monthly', 'gbp'), '£15')
  assert.equal(priceDisplay('pro', 'monthly', 'usd'), '$19')
  // Pro annual is the yearly total.
  assert.equal(priceDisplay('pro', 'annual', 'gbp'), '£144')
  assert.equal(priceDisplay('pro', 'annual', 'usd'), '$180')
  // Team.
  assert.equal(priceDisplay('team', 'monthly', 'gbp'), '£65')
  assert.equal(priceDisplay('team', 'monthly', 'usd'), '$79')
  assert.equal(priceDisplay('team', 'annual', 'gbp'), '£624')
  assert.equal(priceDisplay('team', 'annual', 'usd'), '$756')
  // Enterprise: floor price, annual only.
  assert.equal(priceDisplay('enterprise', 'annual', 'gbp'), 'From £750')
  assert.equal(priceDisplay('enterprise', 'annual', 'usd'), 'From $950')
  assert.equal(priceDisplay('enterprise', 'monthly', 'gbp'), 'Annual only')
  assert.equal(priceDisplay('enterprise', 'monthly', 'usd'), 'Annual only')
  assert.equal(priceSuffixFor('enterprise', 'annual'), '/ mo')
  assert.equal(priceNoteFor('enterprise', 'annual'), 'billed annually')
  // Interval suffixes.
  assert.equal(pricingIntervalSuffix('monthly'), '/ mo')
  assert.equal(pricingIntervalSuffix('annual'), '/ yr')
  assert.equal(formatPricingAmount('gbp', 15), '£15')
  assert.equal(formatPricingAmount('usd', 180), '$180')
})

test('limits: decisions, seats and retention match the approved tiers', () => {
  assert.deepEqual(PRICING_LIMITS.solo, { decisionsPerMonth: 300, seats: 2, retentionDays: 10 })
  assert.deepEqual(PRICING_LIMITS.pro, { decisionsPerMonth: 2500, seats: 3, retentionDays: 30 })
  assert.deepEqual(PRICING_LIMITS.team, { decisionsPerMonth: 20000, seats: 10, retentionDays: 90 })
  assert.deepEqual(PRICING_LIMITS.enterprise, {
    decisionsPerMonth: null,
    seats: null,
    retentionDays: 1000,
  })
  // Displayed labels.
  assert.equal(decisionsLabel(PRICING_LIMITS.solo), '300')
  assert.equal(decisionsLabel(PRICING_LIMITS.pro), '2,500')
  assert.equal(decisionsLabel(PRICING_LIMITS.team), '20,000')
  assert.equal(decisionsLabel(PRICING_LIMITS.enterprise), 'Custom')
  assert.equal(seatsLabel(PRICING_LIMITS.solo), '2')
  assert.equal(seatsLabel(PRICING_LIMITS.pro), '3')
  assert.equal(seatsLabel(PRICING_LIMITS.team), '10')
  assert.equal(seatsLabel(PRICING_LIMITS.enterprise), 'Custom')
  assert.equal(retentionLabel(PRICING_LIMITS.solo), '10 days')
  assert.equal(retentionLabel(PRICING_LIMITS.pro), '30 days')
  assert.equal(retentionLabel(PRICING_LIMITS.team), '90 days')
  // PM ruling: Enterprise completed retention is the concrete 1000-day
  // limit (imported by the tier_limits seed later); the marketing copy is
  // contract-style via the per-tier display override.
  assert.equal(retentionLabel(PRICING_LIMITS.enterprise), '1000 days')
  assert.equal(
    retentionDisplayFor(pricingTier('enterprise')!),
    'Custom, up to 7 years',
  )
  // A genuinely null limit still falls back to the contract-style copy.
  assert.equal(
    retentionLabel({ decisionsPerMonth: null, seats: null, retentionDays: null }),
    'Custom, up to 7 years',
  )
  // Only Enterprise carries a display override.
  for (const id of ['solo', 'pro', 'team'] as const) {
    assert.equal(pricingTier(id)?.retentionDisplay, undefined, `${id} must not override retention`)
  }
  // Each tier carries its limits by reference.
  for (const tier of PRICING_TIERS) {
    assert.deepEqual(tier.limits, PRICING_LIMITS[tier.id])
  }
})

test('CTAs: only Pro is purchasable; CTAs are pinned per tier', () => {
  assert.equal(pricingTier('solo')?.purchasable, false)
  assert.equal(pricingTier('pro')?.purchasable, true)
  assert.equal(pricingTier('team')?.purchasable, false)
  assert.equal(pricingTier('enterprise')?.purchasable, false)
  assert.equal(isPurchasablePlan('pro'), true)
  assert.equal(isPurchasablePlan('solo'), false)
  assert.equal(isPurchasablePlan('team'), false)
  assert.equal(isPurchasablePlan('enterprise'), false)

  assert.equal(pricingTier('solo')?.cta, 'Start free')
  assert.equal(pricingTier('pro')?.cta, 'Upgrade to Pro')
  assert.equal(pricingTier('team')?.cta, 'Contact us')
  assert.equal(pricingTier('enterprise')?.cta, 'Contact')
})

test('SSO: Google/Slack at Team; SAML and other providers at Enterprise only', () => {
  assert.equal(pricingTier('solo')?.ssoLabel, '—')
  assert.equal(pricingTier('pro')?.ssoLabel, '—')
  assert.equal(pricingTier('team')?.ssoLabel, 'Google and Slack')
  assert.equal(pricingTier('enterprise')?.ssoLabel, 'SAML and all providers')
})

test('Stripe: only Pro carries lookup keys; no Price ids in config', () => {
  assert.equal(stripeLookupKey('pro', 'monthly'), 'pro_monthly')
  assert.equal(stripeLookupKey('pro', 'annual'), 'pro_annual')
  assert.equal(stripeLookupKey('solo', 'monthly'), null)
  assert.equal(stripeLookupKey('team', 'monthly'), null)
  assert.equal(stripeLookupKey('enterprise', 'annual'), null)
  // No Stripe Price ids (price_...) anywhere in the config.
  const json = JSON.stringify(PRICING_TIERS)
  assert.ok(!/price_[A-Za-z0-9]+/.test(json), 'config must not contain Stripe Price ids')
})

test('VAT note is present and states prices exclude VAT', () => {
  assert.match(PRICING_VAT_NOTE, /exclude VAT/i)
  assert.ok(PRICING_CONTACT_EMAIL.includes('@'))
})
