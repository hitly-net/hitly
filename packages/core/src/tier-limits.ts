/**
 * Tier limits map: the single source of truth for the numeric caps each
 * workspace plan unlocks.
 *
 * The live map is the `tier_limits` DB table (seeded by migration 0018) and
 * every numeric cap in the product must read it through the helper
 * `limit(workspace, key)` (apps/app/lib/tier-limits.ts). Raising or lowering
 * a cap is one SQL statement — no code change, no deploy:
 *
 *   UPDATE tier_limits SET value = 5000 WHERE plan = 'pro' AND limit_key = 'decisions_per_month';
 *
 * A NULL value means unlimited for that plan. Deleting a row (or never
 * seeding one) blocks new use of that capability for that plan — the same
 * fail-closed rule the boolean map uses for missing feature rows. The
 * self-hosted plan is seeded entirely NULL so OSS behavior never changes.
 *
 * This module is pure (no imports with side effects): it holds the key
 * registry, the seed the migration mirrors, and the pure resolver
 * `limitFromMap`. Numeric caps gate NEW use only; existing state created
 * under a richer plan stays readable, exportable and deletable after a
 * downgrade.
 */
import type { WorkspacePlan } from './edition.ts'

/** Every numeric limit key the map may hold. Unknown keys are always denied. */
export const TIER_LIMIT_KEYS = [
  /** Decisions (approval requests) a workspace may create in a calendar month. */
  'decisions_per_month',
  /** People a workspace may invite (members + pending invites). */
  'seats',
  /** Projects that may be in the `live` state at once. */
  'live_projects',
  /** Project API keys a workspace may hold. */
  'api_keys',
  /** Callback endpoints one project may register. */
  'callback_endpoints_per_project',
  /** Requests per minute one REST API key may make. */
  'api_rpm',
  /** Days a closed (decided/expired/cancelled) inbox item is kept. */
  'completed_retention_days',
  /** Days an audit (project event) row is kept. */
  'audit_retention_days',
] as const

export type TierLimitKey = (typeof TIER_LIMIT_KEYS)[number]

export function isTierLimitKey(value: string): value is TierLimitKey {
  return (TIER_LIMIT_KEYS as readonly string[]).includes(value)
}

/**
 * Seed for the `tier_limits` table, mirrored verbatim by migration 0018.
 * The DB is the runtime source of truth; this constant documents the seed,
 * backs the seed guard test, and is what a fresh install starts from.
 * Values follow the published tiers; `null` means unlimited. self-hosted is
 * unlimited everywhere so the OSS edition is never capped.
 */
export const TIER_LIMIT_SEED: Record<TierLimitKey, Record<WorkspacePlan, number | null>> = {
  decisions_per_month: { 'self-hosted': null, solo: 300, pro: 2500, team: 20000, enterprise: null },
  seats: { 'self-hosted': null, solo: 2, pro: 3, team: null, enterprise: null },
  live_projects: { 'self-hosted': null, solo: 2, pro: 10, team: null, enterprise: null },
  api_keys: { 'self-hosted': null, solo: 2, pro: 10, team: null, enterprise: null },
  callback_endpoints_per_project: { 'self-hosted': null, solo: 1, pro: 3, team: 10, enterprise: null },
  api_rpm: { 'self-hosted': null, solo: 60, pro: 300, team: 1200, enterprise: 3000 },
  completed_retention_days: { 'self-hosted': null, solo: 10, pro: 30, team: 365, enterprise: 1000 },
  audit_retention_days: { 'self-hosted': null, solo: 30, pro: 365, team: 365, enterprise: 2555 },
}

/** Rows as the DB stores them: one (plan, limit_key) → value (null = unlimited). */
export type LimitsMap = Map<string, Map<string, number | null>>

/** Normalize raw DB rows (or the seed) into the lookup structure. */
export function buildLimitsMap(
  rows: Iterable<{ plan: string; limitKey: string; value: number | null }>,
): LimitsMap {
  const map: LimitsMap = new Map()
  for (const row of rows) {
    let byKey = map.get(row.plan)
    if (!byKey) {
      byKey = new Map()
      map.set(row.plan, byKey)
    }
    byKey.set(row.limitKey, row.value)
  }
  return map
}

export type LimitRead =
  /** Row found; `value: null` means unlimited. */
  | { status: 'ok'; value: number | null }
  /** Fail-closed deny: unknown key, unknown plan, or missing row. */
  | { status: 'denied'; reason: 'unknown_key' | 'unknown_plan' | 'missing_row' | 'database_unavailable' }

/**
 * Pure resolver behind limit(). Denies (with a machine-readable reason) for
 * unknown keys, unknown plans and missing rows; callers treat a deny like a
 * cap of zero. Emits no logs — the caller logs one value-free line.
 */
export function limitFromMap(map: LimitsMap, workspace: { plan: string }, key: string): LimitRead {
  if (!isTierLimitKey(key)) return { status: 'denied', reason: 'unknown_key' }
  const byKey = map.get(workspace.plan)
  if (!byKey) return { status: 'denied', reason: 'unknown_plan' }
  if (!byKey.has(key)) return { status: 'denied', reason: 'missing_row' }
  return { status: 'ok', value: byKey.get(key) ?? null }
}

/**
 * Pure usage check used by quota gates: a deny or a reached cap refuses NEW
 * use. `usage` is the count of already-existing units for the key.
 */
export function withinLimit(read: LimitRead, usage: number): boolean {
  if (read.status === 'denied') return false
  if (read.value === null) return true
  return usage < read.value
}
