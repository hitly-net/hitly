/**
 * Client-safe tier refusal vocabulary: the stable code, the key list as
 * data, and the types/predicates the refusal UI needs. Kept free of any
 * database import so Client Components can use it without dragging the
 * server stack (drizzle/pg) into the browser bundle — see the Next.js
 * module-not-found on `util/types` this file exists to prevent.
 *
 * The server side (lib/tier-enforcement.ts) imports and re-exports all of
 * this, so there is exactly one definition of every symbol here.
 */

/** Stable machine code carried by every tier refusal (REST body, MCP result, typed action state). */
export const TIER_LIMIT_CODE = 'tier_limit_reached' as const
/** HTTP status every REST refusal uses: payment required (a plan change unblocks it). */
export const TIER_LIMIT_HTTP_STATUS = 402
/** Keys lib/tier-enforcement.ts gates. The remaining tier_limits keys are enforced by their own sweeps/limiters. */
export const ENFORCED_TIER_LIMIT_KEYS = [
  'decisions_per_month',
  'seats',
  'live_projects',
  'completed_retention_days',
] as const
export type EnforcedTierLimitKey = (typeof ENFORCED_TIER_LIMIT_KEYS)[number]

export type TierRefusal = {
  code: typeof TIER_LIMIT_CODE
  limitKey: EnforcedTierLimitKey
  message: string
  limit: number | null
  usage: number
}

/** Typed result a server action returns when a cap refuses (never a throw), mirroring GateBlockedResult. */
export type TierLimitBlockedResult = {
  status: 'error'
  code: typeof TIER_LIMIT_CODE
  limitKey: EnforcedTierLimitKey
  message: string
}

export function isTierLimitBlockedResult(value: unknown): value is TierLimitBlockedResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'error' &&
    (value as { code?: unknown }).code === TIER_LIMIT_CODE
  )
}

/**
 * The upgrade path for the refusal UI: Free/Pro link to the app's /signup
 * billing entry; Team/Enterprise show the pricing contact path; self-hosted
 * (all caps NULL = unlimited) never sees a refusal and gets no upgrade link.
 */
export type UpgradeHint = { label: string; href: string }

/** limit + usage pair for the UI meter: what the cap is and how much is used. */
export type TierUsage = {
  limitKey: EnforcedTierLimitKey
  usage: number
  /** null = unlimited; a deny (missing row etc.) surfaces as reached with null. */
  limit: number | null
  /** True when NEW use would be refused right now (at/over the cap or fail-closed deny). */
  reached: boolean
  upgrade: UpgradeHint | null
}
