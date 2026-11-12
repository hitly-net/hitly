/**
 * The single read path for tier entitlements.
 *
 * Every boolean feature gate in the product must call can() here — no
 * module may compare workspace.plan against a plan name. The map is the
 * `tier_entitlements` DB table (seeded by migration 0015), so moving a
 * feature between tiers is a single UPDATE with no code change:
 *
 *   UPDATE tier_entitlements SET min_plan = 'pro' WHERE feature = 'sso_google';
 *
 * Rows are cached for HITLY_TIER_ENTITLEMENTS_TTL_MS: unset, empty or
 * invalid values use the default 10000 ms (never cache-off), 0 disables
 * the cache, and values clamp to a maximum of 300000 ms. An UPDATE takes
 * effect within the TTL without a restart. Fail-closed: an unknown
 * feature, a missing row, an unknown plan, or a missing/unreachable
 * database all deny and emit exactly one value-free log line.
 *
 * Gates cover NEW use only: management of existing state (MFA disable and
 * recovery-code regeneration, the sign-in challenge, passkey removal,
 * project deletion) never consults can(). Only enrolment-style affordances
 * and routes do.
 *
 * Seed rules (migration 0015 / TIER_ENTITLEMENT_SEED in @hitly/core):
 *   mfa                    all plans
 *   sso_google, sso_slack  Team and above
 *   sso_microsoft, sso_github, sso_saml, sso (other SSO)   Enterprise
 *   project_lifecycle      all plans
 */
import { ENTITLEMENT_FEATURES, canFromMap, type EntitlementMap } from '@hitly/core'
import { tierEntitlements } from '@hitly/db/schema'
import { db } from './db'
import { requireApiWorkspace } from './api-session'

const LOG_PREFIX = '[hitly entitlements]'
const DEFAULT_TTL_MS = 10_000
/** Upper bound on the cache window; larger configured values clamp here. */
export const MAX_TTL_MS = 300_000

/**
 * HITLY_TIER_ENTITLEMENTS_TTL_MS parsing (product ruling): unset, empty,
 * blank or unparseable values mean the 10s DEFAULT — never cache-off.
 * A valid 0 still disables the cache; negatives are invalid (default);
 * any valid value clamps into [0, MAX_TTL_MS].
 */
export function parseTtlMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TTL_MS
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_TTL_MS
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_TTL_MS
  return Math.min(Math.floor(value), MAX_TTL_MS)
}

let cached: { map: Map<string, string>; expiresAt: number } | null = null

function ttlMs(): number {
  return parseTtlMs(process.env.HITLY_TIER_ENTITLEMENTS_TTL_MS)
}

/** Test seam: forces the next read to re-query the table. */
export function invalidateTierEntitlementsCache(): void {
  cached = null
}

async function loadMap(): Promise<EntitlementMap | null> {
  if (!db) return null
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.map
  try {
    const rows = await db
      .select({ feature: tierEntitlements.feature, minPlan: tierEntitlements.minPlan })
      .from(tierEntitlements)
    const map = new Map(rows.map((row) => [row.feature, row.minPlan]))
    cached = { map, expiresAt: now + ttlMs() }
    return map
  } catch {
    // Missing table, connection failure, or any other DB error: never
    // propagate — callers deny. Failures are never cached, so the next
    // read retries once the database recovers.
    return null
  }
}

/**
 * The one helper every feature check goes through. Denies (and logs) for
 * unknown features, removed rows, unknown plans, and a missing database.
 */
export async function can(workspace: { plan: string }, feature: string): Promise<boolean> {
  const log = (line: string) => console.warn(line)
  const map = await loadMap()
  if (!map) {
    log(`${LOG_PREFIX} database unavailable; denied "${feature}"`)
    return false
  }
  return canFromMap(map, workspace, feature, log)
}

/** Every registered feature for a workspace, for UI affordances (MFA/SSO setup). */
export async function getEntitlementsForWorkspace(
  workspace: { plan: string },
): Promise<Record<string, boolean>> {
  const features: Record<string, boolean> = {}
  for (const feature of ENTITLEMENT_FEATURES) {
    features[feature] = await can(workspace, feature)
  }
  return features
}

export type CanForCurrentWorkspaceDeps = {
  /** Test seam. Default: the session's current workspace (api-session rules). */
  resolveWorkspace?: () => Promise<{ plan: string } | null>
  log?: (line: string) => void
}

/** can() against the session's current workspace; denies when there is none. */
export async function canForCurrentWorkspace(
  feature: string,
  deps: CanForCurrentWorkspaceDeps = {},
): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const resolveWorkspace = deps.resolveWorkspace ?? defaultResolveWorkspace
  let workspace: { plan: string } | null
  try {
    workspace = await resolveWorkspace()
  } catch {
    // Session/workspace lookup failed (e.g. database down): deny, never 500.
    log(`${LOG_PREFIX} workspace lookup failed; denied "${feature}"`)
    return false
  }
  if (!workspace) {
    log(`${LOG_PREFIX} no current workspace; denied "${feature}"`)
    return false
  }
  return can(workspace, feature)
}

async function defaultResolveWorkspace(): Promise<{ plan: string } | null> {
  const ctx = await requireApiWorkspace()
  return ctx.ok ? ctx.workspace : null
}
