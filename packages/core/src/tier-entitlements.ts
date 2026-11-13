/**
 * Tier entitlements map: the single source of truth for which boolean
 * features a workspace plan unlocks.
 *
 * The live map is the `tier_entitlements` DB table (seeded by migration
 * 0015) and the whole app reads it through one helper,
 * `can(workspace, feature)` in apps/app/lib/tier-entitlements.ts. Moving a
 * feature between tiers is one SQL statement against that table — no code
 * change, no deploy:
 *
 *   UPDATE tier_entitlements SET min_plan = 'pro' WHERE feature = 'sso_google';
 *
 * This module is pure (no imports with side effects): it holds the feature
 * registry, the plan ordering, the seed the migration mirrors, the provider
 * mapping, and the pure resolver `canFromMap`.
 *
 * Deny policy (fail-closed): an unknown feature, a missing row, an unknown
 * plan, or an unknown min_plan all deny and emit one log line. Nothing in a
 * log line ever contains secrets.
 */
import type { WorkspacePlan } from './edition.ts'

/** Every feature name the map may gate. Unknown names are always denied. */
export const ENTITLEMENT_FEATURES = [
  'mfa',
  'sso_google',
  'sso_slack',
  'sso_microsoft',
  'sso_github',
  'sso_saml',
  'sso',
  'project_lifecycle',
] as const

export type EntitlementFeature = (typeof ENTITLEMENT_FEATURES)[number]

export function isEntitlementFeature(value: string): value is EntitlementFeature {
  return (ENTITLEMENT_FEATURES as readonly string[]).includes(value)
}

/** Least to most privileged. A feature unlocks when the workspace plan
 * reaches the feature's minimum plan. */
const PLAN_RANK: Record<WorkspacePlan, number> = {
  'self-hosted': 0,
  solo: 1,
  pro: 2,
  team: 3,
  enterprise: 4,
}

/** -1 for anything that is not a known plan (deny path). */
export function planRank(plan: string): number {
  return (PLAN_RANK as Record<string, number>)[plan] ?? -1
}

/**
 * Seed for the `tier_entitlements` table, mirrored verbatim by migration
 * 0015. The DB is the runtime source of truth; this constant documents the
 * seed, backs the seed tests, and is what a fresh install starts from.
 * 'self-hosted' as a minimum plan means "all tiers".
 */
export const TIER_ENTITLEMENT_SEED: Record<EntitlementFeature, WorkspacePlan> = {
  /** Authenticator-app MFA: every plan. */
  mfa: 'self-hosted',
  /** Google/Gmail social sign-in: Team and above. */
  sso_google: 'team',
  /** Slack social sign-in: Team and above. */
  sso_slack: 'team',
  /** Microsoft/Entra social sign-in: Enterprise. */
  sso_microsoft: 'enterprise',
  /** GitHub social sign-in: Enterprise. */
  sso_github: 'enterprise',
  /** SAML federation: Enterprise. */
  sso_saml: 'enterprise',
  /** Any other SSO provider: Enterprise. */
  sso: 'enterprise',
  /** Project pause/archive: every plan (was a hardcoded `true`). */
  project_lifecycle: 'self-hosted',
}

/**
 * Map a social/SSO provider id to the feature that gates it. Anything not
 * explicitly known falls back to the generic `sso` feature (seeded at
 * Enterprise), so a newly wired provider is gated, never accidentally free.
 */
export function ssoFeatureForProvider(providerId: string): EntitlementFeature {
  switch (providerId.trim().toLowerCase()) {
    case 'google':
    case 'gmail':
      return 'sso_google'
    case 'slack':
      return 'sso_slack'
    case 'microsoft':
    case 'azure':
    case 'entra':
    case 'entra-id':
      return 'sso_microsoft'
    case 'github':
      return 'sso_github'
    case 'saml':
      return 'sso_saml'
    default:
      return 'sso'
  }
}

export type EntitlementMap = ReadonlyMap<string, string>

export function seedAsMap(): Map<string, string> {
  return new Map<string, string>(Object.entries(TIER_ENTITLEMENT_SEED))
}

/**
 * Pure resolver behind `can()`. Every deny path reports through `log`
 * exactly once. Kept pure so the seed rules are testable without a database.
 */
export function canFromMap(
  map: EntitlementMap,
  workspace: { plan: string },
  feature: string,
  log: (line: string) => void,
): boolean {
  if (!isEntitlementFeature(feature)) {
    log(`[hitly entitlements] unknown feature "${feature}"; denied`)
    return false
  }
  const minPlan = map.get(feature)
  if (!minPlan) {
    log(`[hitly entitlements] no entitlement row for "${feature}"; denied`)
    return false
  }
  const rank = planRank(workspace.plan)
  if (rank < 0) {
    log(`[hitly entitlements] unknown workspace plan "${workspace.plan}"; denied "${feature}"`)
    return false
  }
  const minRank = planRank(minPlan)
  if (minRank < 0) {
    log(`[hitly entitlements] unknown min_plan "${minPlan}" for "${feature}"; denied`)
    return false
  }
  return rank >= minRank
}
