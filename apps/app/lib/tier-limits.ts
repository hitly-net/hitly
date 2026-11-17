/**
 * The single read path for tier limits (numeric caps).
 *
 * Every numeric quota gate in the product must call limit() here — no module
 * may compare workspace.plan against a plan name or hard-code a cap. The map
 * is the `tier_limits` DB table (seeded by migration 0019), so moving a cap
 * is a single UPDATE with no code change:
 *
 *   UPDATE tier_limits SET value = 5000 WHERE plan = 'pro' AND limit_key = 'decisions_per_month';
 *
 * A NULL value means unlimited. Fail-closed: an unknown key, a missing row,
 * an unknown plan, or a missing/unreachable database all deny — callers must
 * treat a deny like a cap of zero for NEW use. Each deny emits exactly one
 * value-free log line. Gates cover NEW use only: state created under a
 * richer plan stays readable, exportable and deletable after a downgrade.
 *
 * Rows are cached for HITLY_TIER_LIMITS_TTL_MS using the same parsing rules
 * as the entitlements cache (default 10s, 0 disables, clamp 300s max).
 */
import { limitFromMap, buildLimitsMap, withinLimit, type LimitRead, type LimitsMap } from '@hitly/core'
import { tierLimits } from '@hitly/db/schema'
import { db } from './db'
import { requireApiWorkspace } from './api-session'
import { parseTtlMs } from './tier-entitlements'

const LOG_PREFIX = '[hitly tier limits]'

let cached: { map: LimitsMap; expiresAt: number } | null = null

function ttlMs(): number {
  return parseTtlMs(process.env.HITLY_TIER_LIMITS_TTL_MS)
}

/** Test seam: forces the next read to re-query the table. */
export function invalidateTierLimitsCache(): void {
  cached = null
}

async function loadMap(): Promise<LimitsMap | null> {
  if (!db) return null
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.map
  try {
    const rows = await db
      .select({ plan: tierLimits.plan, limitKey: tierLimits.limitKey, value: tierLimits.value })
      .from(tierLimits)
    const map = buildLimitsMap(rows)
    cached = { map, expiresAt: now + ttlMs() }
    return map
  } catch {
    // Missing table, connection failure, or any other DB error: never
    // propagate — callers block. Failures are never cached, so the next
    // read retries once the database recovers.
    return null
  }
}

/**
 * The one helper every numeric cap check goes through. Returns 'ok' with the
 * configured value (null = unlimited), or 'denied' for unknown keys, removed
 * rows, unknown plans, and a missing database (all fail-closed).
 */
export async function limit(workspace: { plan: string }, key: string): Promise<LimitRead> {
  const log = (line: string) => console.warn(line)
  const map = await loadMap()
  if (!map) {
    log(`${LOG_PREFIX} database unavailable; blocked "${key}"`)
    return { status: 'denied', reason: 'database_unavailable' }
  }
  const read = limitFromMap(map, workspace, key)
  if (read.status === 'denied') {
    log(`${LOG_PREFIX} ${read.reason}; blocked "${key}" for plan`)
  }
  return read
}

export type QuotaCheck =
  | { allowed: true; limit: number | null }
  | { allowed: false; limit: number | null; reason: 'unknown_key' | 'unknown_plan' | 'missing_row' | 'at_limit' | 'database_unavailable' }

/**
 * Pure usage gate for NEW use: compares an existing-unit count against the
 * plan's cap. A deny (unknown key/row/plan, no database) blocks, like a cap
 * of zero. `usage` counts units already occupying the cap.
 */
export async function checkQuota(
  workspace: { plan: string },
  key: string,
  usage: number,
): Promise<QuotaCheck> {
  const read = await limit(workspace, key)
  if (read.status === 'denied') {
    return { allowed: false, limit: 0, reason: read.reason }
  }
  if (!withinLimit(read, usage)) {
    return { allowed: false, limit: read.value, reason: 'at_limit' }
  }
  return { allowed: true, limit: read.value }
}

export type LimitForCurrentWorkspaceDeps = {
  /** Test seam. Default: the session's current workspace (api-session rules). */
  resolveWorkspace?: () => Promise<{ plan: string } | null>
}

/** limit() against the session's current workspace; denies when there is none. */
export async function limitForCurrentWorkspace(
  key: string,
  deps: LimitForCurrentWorkspaceDeps = {},
): Promise<LimitRead> {
  const log = (line: string) => console.warn(line)
  const resolveWorkspace = deps.resolveWorkspace ?? defaultResolveWorkspace
  let workspace: { plan: string } | null
  try {
    workspace = await resolveWorkspace()
  } catch {
    // Session/workspace lookup failed (e.g. database down): block, never 500.
    log(`${LOG_PREFIX} workspace lookup failed; blocked "${key}"`)
    return { status: 'denied', reason: 'unknown_plan' }
  }
  if (!workspace) {
    log(`${LOG_PREFIX} no current workspace; blocked "${key}"`)
    return { status: 'denied', reason: 'unknown_plan' }
  }
  return limit(workspace, key)
}

async function defaultResolveWorkspace(): Promise<{ plan: string } | null> {
  const ctx = await requireApiWorkspace()
  return ctx.ok ? ctx.workspace : null
}
