/**
 * Tier limit enforcement: the refusal layer for NEW use of capped actions.
 *
 * Every capped write path (decisions per month, seats, live projects,
 * retention-bound retries, API-key creation) calls one of the gate/assert
 * helpers here. They read the numeric cap through the single read path
 * `checkQuota` (see lib/tier-limits.ts, the `tier_limits` table seeded from
 * the core pricing config) and refuse NEW use over the cap with a stable
 * error code (`tier_limit_reached`) and a human message naming the limit
 * and usage.
 *
 * Refusals are for NEW use only. State created under a richer plan stays
 * readable, exportable and deletable after a downgrade — no gate here reads
 * or blocks existing data; gates run before the insert/state-change of the
 * action they cap.
 *
 * Fail-closed: an unknown key, a missing row, an unknown plan or an
 * unreachable database refuse like a cap of zero (the doctrine of
 * lib/tier-limits.ts, inherited via checkQuota).
 *
 * Check-then-write is only race-safe when it runs inside a per-(workspace,
 * key) serialisation: capped creates take `lockTierSeries` (a
 * pg_advisory_xact_lock, the member-guard/create-once idiom) so concurrent
 * requests at cap-1 serialize on the count and exactly one wins; losers get
 * a clean tier refusal, not a unique-violation error.
 *
 * The upgrade path shown next to a refusal is derived from the plan:
 * Free (solo) and Pro link to the app's /signup billing entry; Team and
 * Enterprise show the pricing contact path; self-hosted gets no upgrade
 * link (OSS is unlimited on every key).
 */
import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { PRICING_CONTACT_EMAIL, type WorkspacePlan } from '@hitly/core'
import { approvals, invites, memberships, projectApiKeys, projects, workspaces } from '@hitly/db/schema'
import { checkQuota } from './tier-limits'
import type { TenantDatabase } from './tenant'

// The client-safe vocabulary (code, key list, refusal/usage types) lives in
// lib/tier-limit-result.ts so Client Components never pull this module's
// database stack into the browser bundle; re-exported here so every server
// import path keeps working from a single definition.
import {
  TIER_LIMIT_CODE,
  type EnforcedTierLimitKey,
  type TierRefusal,
  type TierLimitBlockedResult,
  type UpgradeHint,
  type TierUsage,
} from './tier-limit-result'
export { TIER_LIMIT_CODE, TIER_LIMIT_HTTP_STATUS, ENFORCED_TIER_LIMIT_KEYS, isTierLimitBlockedResult } from './tier-limit-result'
export type { EnforcedTierLimitKey, TierRefusal, TierLimitBlockedResult, UpgradeHint, TierUsage } from './tier-limit-result'

const DAY_MS = 24 * 60 * 60 * 1000

/** Shown when the read is denied (missing row, unknown plan/key, database down): fail-closed. */
export const TIER_NOT_AVAILABLE_MESSAGE =
  "This action isn't available on your current plan. Upgrade to unlock it."

/** Human message naming the limit and the usage, per capped action. */
export function tierLimitMessage(key: EnforcedTierLimitKey, limit: number, usage: number): string {
  switch (key) {
    case 'decisions_per_month':
      return `Monthly decision limit reached (${limit} of ${limit} decisions used this month). Upgrade to allow more decisions per month.`
    case 'seats':
      return `Seat limit reached (${limit} of ${limit} seats in use, counting members and pending invites). Remove a person or upgrade to add more.`
    case 'live_projects':
      return `Live project limit reached (${limit} of ${limit} projects live at once). Pause or archive a project, or upgrade to run more.`
    case 'completed_retention_days':
      return `This item is ${usage} days old — past your plan's ${limit}-day retention for completed items. Upgrade to extend retention.`
    case 'api_keys':
      return `API key limit reached (${limit} of ${limit} API keys in use). Delete a key or upgrade to create more.`
  }
}

export type TierGate = { allowed: true; limit: number | null } | ({ allowed: false } & TierRefusal)

async function gate(workspace: { plan: string }, key: EnforcedTierLimitKey, usage: number): Promise<TierGate> {
  const check = await checkQuota(workspace, key, usage)
  if (check.allowed) return { allowed: true, limit: check.limit }
  const atCap = check.reason === 'at_limit' && check.limit !== null
  const message = atCap ? tierLimitMessage(key, check.limit as number, usage) : TIER_NOT_AVAILABLE_MESSAGE
  return { allowed: false, code: TIER_LIMIT_CODE, limitKey: key, message, limit: check.limit, usage }
}

/** Decisions (approval requests) created in the current UTC calendar month. */
export const gateMonthlyDecisions = (workspace: { plan: string }, usage: number) =>
  gate(workspace, 'decisions_per_month', usage)
/** Seats = members + pending (unaccepted, unexpired) invites. */
export const gateSeat = (workspace: { plan: string }, usage: number) => gate(workspace, 'seats', usage)
/** Projects in the `live` state at once. */
export const gateLiveProject = (workspace: { plan: string }, usage: number) => gate(workspace, 'live_projects', usage)
/** Retention-bound action: whole days of age against the plan's completed-item retention. */
export const gateRetentionBound = (workspace: { plan: string }, ageDays: number) =>
  gate(workspace, 'completed_retention_days', ageDays)
/** Project API keys in the workspace (rotation of an existing key is not new use). */
export const gateApiKey = (workspace: { plan: string }, usage: number) => gate(workspace, 'api_keys', usage)

/**
 * Thrown out of a tenant transaction by a single-writer chokepoint (invite
 * send, member add, project insert, API-key insert) so nothing written
 * before the gate commits — the action converts it to the typed result
 * AFTER the transaction has been discarded (house gate pattern,
 * lib/verified-gate.ts).
 */
export class TierLimitError extends Error {
  readonly code = TIER_LIMIT_CODE
  readonly refusal: TierRefusal
  constructor(refusal: TierRefusal) {
    super(refusal.message)
    this.refusal = refusal
  }
}

async function assertGate(workspace: { plan: string }, key: EnforcedTierLimitKey, usage: number): Promise<void> {
  const result = await gate(workspace, key, usage)
  if (!result.allowed) throw new TierLimitError(result)
}

export const assertMonthlyDecisions = (w: { plan: string }, usage: number) =>
  assertGate(w, 'decisions_per_month', usage)
export const assertSeat = (w: { plan: string }, usage: number) => assertGate(w, 'seats', usage)
export const assertLiveProject = (w: { plan: string }, usage: number) => assertGate(w, 'live_projects', usage)
export const assertRetentionBound = (w: { plan: string }, ageDays: number) =>
  assertGate(w, 'completed_retention_days', ageDays)
export const assertApiKey = (w: { plan: string }, usage: number) => assertGate(w, 'api_keys', usage)

export function tierLimitBlockedResult(refusal: TierRefusal): TierLimitBlockedResult {
  return { status: 'error', code: TIER_LIMIT_CODE, limitKey: refusal.limitKey, message: refusal.message }
}

/** Maps a thrown value onto the typed refusal; null for anything else (caller rethrows). */
export function toTierLimitBlockedResult(error: unknown): TierLimitBlockedResult | null {
  return error instanceof TierLimitError ? tierLimitBlockedResult(error.refusal) : null
}

/** Build the refusal body a REST route returns (error + stable code + machine fields). */
export function tierRefusalBody(refusal: TierRefusal): {
  error: string
  code: typeof TIER_LIMIT_CODE
  limitKey: EnforcedTierLimitKey
  limit: number | null
  usage: number
} {
  return {
    error: refusal.message,
    code: TIER_LIMIT_CODE,
    limitKey: refusal.limitKey,
    limit: refusal.limit,
    usage: refusal.usage,
  }
}

/**
 * Plain-text variant of the ingest result's machine code. The ingest contract
 * stays assignable to it; the literal is kept as its own exported constant so
 * routes and tests compare against the same value.
 */
export const TIER_LIMIT_RESULT_CODE: typeof TIER_LIMIT_CODE = TIER_LIMIT_CODE

export const SIGNUP_BILLING_HREF = '/signup'
// Plans as DATA, never branch logic on a plan name (tier-entitlements guard
// doctrine): Free/Pro self-serve at the app's /signup billing entry,
// Team/Enterprise show the pricing contact path, self-hosted (all caps NULL)
// never sees a refusal and gets no upgrade link.
const UPGRADE_HINT_BY_PLAN: Partial<Record<WorkspacePlan, UpgradeHint | null>> = {
  solo: { label: 'Upgrade', href: SIGNUP_BILLING_HREF },
  pro: { label: 'Upgrade', href: SIGNUP_BILLING_HREF },
  team: { label: 'Contact us', href: `mailto:${PRICING_CONTACT_EMAIL}` },
  enterprise: { label: 'Contact us', href: `mailto:${PRICING_CONTACT_EMAIL}` },
  'self-hosted': null,
}
export function upgradeHint(plan: string): UpgradeHint | null {
  return UPGRADE_HINT_BY_PLAN[plan as WorkspacePlan] ?? null
}

/**
 * Serialize check-count-then-insert for one (workspace, capped key) for the
 * rest of the current transaction (pg_advisory_xact_lock, the member-guard/
 * create-once idiom). Every capped create path takes exactly one of these
 * locks before counting, so there is no lock nesting and no deadlock
 * ordering to reason about; concurrent losers block, re-count after the
 * winner commits, and receive a clean tier refusal instead of a partial
 * write or a constraint error.
 */
export async function lockTierSeries(
  database: TenantDatabase,
  workspaceId: string,
  key: EnforcedTierLimitKey,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`hitly:tier-enforce:${workspaceId}:${key}`}, 0))`,
  )
}

// ---------------------------------------------------------------------------
// Usage queries. Each counts the units already occupying the cap, from the
// caller's (tenant) database handle, and is used by both the gates and the
// limit/usage display in the UI.
// ---------------------------------------------------------------------------

/** Approvals created in the current UTC calendar month (same window as countApprovalsThisMonth). */
export async function approvalsCreatedThisMonth(database: TenantDatabase, workspaceId: string): Promise<number> {
  const start = new Date()
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  const rows = await database
    .select({ n: sql<number>`count(*)` })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), gte(approvals.createdAt, start)))
  return Number(rows[0]?.n ?? 0)
}

/**
 * Seats in use: members + pending invites (unaccepted, unexpired). A pending
 * invite for `replacingEmail` is NOT counted: that send replaces it, so the
 * seat count does not grow (createAndSendWorkspaceInvite deletes the earlier
 * pending invite for the same address before inserting the new one).
 */
export async function seatUnits(
  database: TenantDatabase,
  workspaceId: string,
  opts: { replacingEmail?: string } = {},
): Promise<number> {
  const memberRows = await database
    .select({ n: sql<number>`count(*)` })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId))
  const pendingWhere = [
    eq(invites.workspaceId, workspaceId),
    isNull(invites.acceptedAt),
    sql`${invites.expiresAt} > now()`,
  ]
  if (opts.replacingEmail) {
    // Replace semantics: createAndSendWorkspaceInvite deletes ANY pending
    // (unaccepted) invite for the address, so an unaccepted same-address
    // invite does not grow the seat count — expired ones were not counted
    // anyway.
    pendingWhere.push(sql`lower(${invites.email}) = lower(${opts.replacingEmail})`)
    const replaced = await database
      .select({ n: sql<number>`count(*)` })
      .from(invites)
      .where(and(...pendingWhere))
    // The replaced row, if any, was counted by the unfiltered count below.
    const replacedCount = Number(replaced[0]?.n ?? 0)
    const allPending = await database
      .select({ n: sql<number>`count(*)` })
      .from(invites)
      .where(and(eq(invites.workspaceId, workspaceId), isNull(invites.acceptedAt), sql`${invites.expiresAt} > now()`))
    return Number(memberRows[0]?.n ?? 0) + Math.max(0, Number(allPending[0]?.n ?? 0) - replacedCount)
  }
  const pendingRows = await database
    .select({ n: sql<number>`count(*)` })
    .from(invites)
    .where(and(...pendingWhere))
  return Number(memberRows[0]?.n ?? 0) + Number(pendingRows[0]?.n ?? 0)
}

/**
 * True when an unaccepted invite for this exact address already exists —
 * i.e. the next send to that address REPLACES it (same predicate as
 * createAndSendWorkspaceInvite's delete). A replacement is not new use: it
 * never grows the seat count, so it is not gated even when existing usage
 * already exceeds the cap (post-downgrade), while any genuinely new seat is.
 */
export async function hasPendingInviteFor(
  database: TenantDatabase,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const rows = await database
    .select({ one: sql`1 as one` })
    .from(invites)
    .where(
      and(
        eq(invites.workspaceId, workspaceId),
        eq(invites.email, email),
        isNull(invites.acceptedAt),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** Projects currently in the `live` state for the workspace. */
export async function liveProjectCount(database: TenantDatabase, workspaceId: string): Promise<number> {
  const rows = await database
    .select({ n: sql<number>`count(*)` })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.status, 'live')))
  return Number(rows[0]?.n ?? 0)
}

/**
 * API keys in the workspace. The cap is PER WORKSPACE (keys belong to the
 * workspace row — the tenant scope — not to the project they are labelled
 * against), and every key counts regardless of last use: rotation replaces
 * the secret in place and therefore never changes this count.
 */
export async function apiKeyCount(database: TenantDatabase, workspaceId: string): Promise<number> {
  const rows = await database
    .select({ n: sql<number>`count(*)` })
    .from(projectApiKeys)
    .where(eq(projectApiKeys.workspaceId, workspaceId))
  return Number(rows[0]?.n ?? 0)
}

/** Whole days between `createdAt` and `now` (floor): the retention-bound usage. */
export function retentionAgeDays(createdAt: Date, now: number = Date.now()): number {
  return Math.floor(Math.max(0, now - createdAt.getTime()) / DAY_MS)
}

/** The workspace's plan; null when the row is gone (fail-closed: caller denies). */
export async function planOfWorkspace(
  database: TenantDatabase,
  workspaceId: string,
): Promise<string | null> {
  const rows = await database
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  return rows[0]?.plan ?? null
}

export async function tierUsageFor(
  workspace: { plan: string },
  key: EnforcedTierLimitKey,
  usage: number,
): Promise<TierUsage> {
  const result = await gate(workspace, key, usage)
  return {
    limitKey: key,
    usage,
    limit: result.limit,
    reached: !result.allowed,
    upgrade: upgradeHint(workspace.plan),
  }
}
