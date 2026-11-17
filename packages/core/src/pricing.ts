/**
 * The single pricing config for HITLy.
 *
 * Both public surfaces read this module and nothing else:
 * - the marketing pricing page (apps/web components/marketing/pricing.tsx)
 * - the Cloud billing page (packages/cloud pages/billing.tsx in hitly-cloud)
 *
 * No component may hard-code a price, limit or CTA: every displayed value is
 * derived from `PRICING_TIERS` / `PRICING_LIMITS` below via the formatter
 * helpers, and the render tests pin that.
 *
 * Limits: `PRICING_LIMITS` is the one source for the numbers shown as plan
 * limits. The `tier_limits` DB seed (packages/core/src/tier-limits.ts, the
 * tier-limits PR) mirrors these values and should import them from here when
 * it next merges main. A `null` limit means unlimited / custom for that plan.
 *
 * Stripe: prices are never referenced by Price id. Purchasable tiers carry
 * Stripe lookup keys; checkout resolves the Price by lookup key at runtime.
 *
 * All prices EXCLUDE VAT — display the `PRICING_VAT_NOTE` alongside them.
 *
 * This module is pure (no side-effect imports), matching the tier-limits /
 * tier-entitlements modules.
 */
import type { CloudPlan } from './edition.ts'

export type PricingCurrency = 'gbp' | 'usd'
export type PricingInterval = 'monthly' | 'annual'

export const PRICING_CURRENCIES: readonly PricingCurrency[] = ['gbp', 'usd']
export const PRICING_INTERVALS: readonly PricingInterval[] = ['monthly', 'annual']

/** Shown next to every price: prices never include VAT. */
export const PRICING_VAT_NOTE = 'All prices exclude VAT.'

/** Where "Contact us" / "Contact" CTAs point. */
export const PRICING_CONTACT_EMAIL = 'hello@hitly.net'

/** Numeric plan limits shown on both pricing surfaces. null = unlimited/custom. */
export type PricingLimits = {
  /** Decisions a workspace may create in a calendar month. */
  decisionsPerMonth: number | null
  /** People who can respond (members + invites). */
  seats: number | null
  /** Days closed decisions and their evidence are kept. */
  retentionDays: number | null
}

/**
 * The single source for displayed plan limits. The `tier_limits` DB seed
 * mirrors this table; when they disagree, this table drives the display and
 * the mismatch is a bug to reconcile in the DB seed, not in the components.
 */
export const PRICING_LIMITS: Record<CloudPlan, PricingLimits> = {
  solo: { decisionsPerMonth: 300, seats: 2, retentionDays: 10 },
  pro: { decisionsPerMonth: 2500, seats: 3, retentionDays: 30 },
  team: { decisionsPerMonth: 20000, seats: 10, retentionDays: 90 },
  enterprise: { decisionsPerMonth: null, seats: null, retentionDays: null },
}

export type PricingTier = {
  id: CloudPlan
  /** Display label. Plan id `solo` displays as "Free" (display only). */
  label: string
  /** Who the tier is for. */
  tagline: string
  /** Only Pro is self-serve purchasable; everything else is contact-driven. */
  purchasable: boolean
  /** CTA text pinned by the tests: Free "Start free", Pro "Upgrade to Pro", Team "Contact us", Enterprise "Contact". */
  cta: string
  /** Enterprise quotes "from" a floor price. */
  fromPrice: boolean
  /** Enterprise is annual contracts only. */
  annualOnly: boolean
  /** Price per billing interval in major currency units. null = not offered. */
  prices: Record<PricingInterval, Record<PricingCurrency, number | null>>
  /**
   * Stripe Price lookup keys (per interval), resolved at runtime by checkout.
   * Never store or display Price ids.
   */
  stripeLookupKeys?: Record<PricingInterval, string>
  limits: PricingLimits
  /** Which SSO the tier includes, as displayed. */
  ssoLabel: string
}

/** Display order on both surfaces. */
export const PRICING_TIERS: readonly PricingTier[] = [
  {
    id: 'solo',
    label: 'Free',
    tagline: 'Indie developers, trying HITLy, marketplace installs.',
    purchasable: false,
    cta: 'Start free',
    fromPrice: false,
    annualOnly: false,
    prices: {
      monthly: { gbp: 0, usd: 0 },
      annual: { gbp: 0, usd: 0 },
    },
    limits: PRICING_LIMITS.solo,
    ssoLabel: '—',
  },
  {
    id: 'pro',
    label: 'Pro',
    tagline: 'Solo builders and small teams running agents in production.',
    purchasable: true,
    cta: 'Upgrade to Pro',
    fromPrice: false,
    annualOnly: false,
    prices: {
      monthly: { gbp: 15, usd: 19 },
      annual: { gbp: 144, usd: 180 },
    },
    stripeLookupKeys: { monthly: 'pro_monthly', annual: 'pro_annual' },
    limits: PRICING_LIMITS.pro,
    ssoLabel: '—',
  },
  {
    id: 'team',
    label: 'Team',
    tagline: 'Product teams with several agents, approvers and projects.',
    purchasable: false,
    cta: 'Contact us',
    fromPrice: false,
    annualOnly: false,
    prices: {
      monthly: { gbp: 65, usd: 79 },
      annual: { gbp: 624, usd: 756 },
    },
    limits: PRICING_LIMITS.team,
    ssoLabel: 'Google and Slack',
  },
  {
    id: 'enterprise',
    label: 'Enterprise',
    tagline: 'Regulated or large organisations.',
    purchasable: false,
    cta: 'Contact',
    fromPrice: true,
    annualOnly: true,
    prices: {
      // Annual contracts, quoted as a monthly floor.
      monthly: { gbp: null, usd: null },
      annual: { gbp: 750, usd: 950 },
    },
    limits: PRICING_LIMITS.enterprise,
    ssoLabel: 'SAML and all providers',
  },
]

export function pricingTier(id: string): PricingTier | null {
  return PRICING_TIERS.find((tier) => tier.id === id) ?? null
}

/** '£15' / '$19' / '£144'. Integers print without decimals. */
export function formatPricingAmount(currency: PricingCurrency, amount: number): string {
  const symbol = currency === 'gbp' ? '£' : '$'
  const text = Number.isInteger(amount)
    ? amount.toLocaleString('en-US')
    : amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${symbol}${text}`
}

/** Interval suffix used next to a price. */
export function pricingIntervalSuffix(interval: PricingInterval): string {
  return interval === 'monthly' ? '/ mo' : '/ yr'
}

/**
 * The pinned price string for a tier under a currency + interval toggle:
 * - '£0' (Free)
 * - '£15' + suffix '/ mo', '£144' + suffix '/ yr' (Pro)
 * - 'From £750' (Enterprise annual; suffix '/ mo', billed annually)
 * - 'Annual only' (Enterprise under the monthly toggle)
 */
export function priceDisplay(
  tierId: CloudPlan,
  interval: PricingInterval,
  currency: PricingCurrency,
): string {
  const tier = pricingTier(tierId)
  if (!tier) return '—'
  const amount = tier.prices[interval][currency]
  if (amount === null) return 'Annual only'
  const prefix = tier.fromPrice ? 'From ' : ''
  return `${prefix}${formatPricingAmount(currency, amount)}`
}

/** Suffix for a tier's price line. Enterprise quotes a monthly floor even annually. */
export function priceSuffixFor(tierId: CloudPlan, interval: PricingInterval): string {
  const tier = pricingTier(tierId)
  if (!tier) return ''
  if (tier.annualOnly) {
    // Enterprise is quoted per month on annual contracts; monthly toggle shows "Annual only".
    return interval === 'annual' ? '/ mo' : ''
  }
  return pricingIntervalSuffix(interval)
}

/** Extra line under the price, e.g. "billed annually" for Enterprise. */
export function priceNoteFor(tierId: CloudPlan, interval: PricingInterval): string | null {
  const tier = pricingTier(tierId)
  if (!tier) return null
  if (tier.annualOnly && interval === 'annual') return 'billed annually'
  return null
}

/** '300' / '2,500' / 'Custom'. */
export function decisionsLabel(limits: PricingLimits): string {
  return limits.decisionsPerMonth === null ? 'Custom' : limits.decisionsPerMonth.toLocaleString('en-US')
}

/** '2' / '3' / 'Custom'. */
export function seatsLabel(limits: PricingLimits): string {
  return limits.seats === null ? 'Custom' : String(limits.seats)
}

/** '10 days' / '30 days' / 'Custom, up to 7 years'. */
export function retentionLabel(limits: PricingLimits): string {
  return limits.retentionDays === null ? 'Custom, up to 7 years' : `${limits.retentionDays} days`
}

/** The Stripe lookup key for a purchasable tier + interval, or null. */
export function stripeLookupKey(
  tierId: CloudPlan,
  interval: PricingInterval,
): string | null {
  const tier = pricingTier(tierId)
  if (!tier || !tier.purchasable || !tier.stripeLookupKeys) return null
  return tier.stripeLookupKeys[interval] ?? null
}

/** True when a plan id is purchasable through self-serve checkout (Pro only). */
export function isPurchasablePlan(plan: string): boolean {
  return pricingTier(plan)?.purchasable === true
}
