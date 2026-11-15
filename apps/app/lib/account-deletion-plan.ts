/**
 * Account deletion — the pure decision core.
 *
 * Everything that decides WHOSE data goes, WHAT is anonymised instead of
 * deleted, and WHETHER the deletion may run at all lives here, so the guards
 * are unit-testable without a database, auth or a browser. The route handlers
 * in lib/account-deletion-route.ts only wire these to Postgres, Better Auth,
 * WebAuthn and the mailer; lib/account-deletion.ts holds the client-safe half
 * (endpoint constants, fixed messages, submit helpers).
 *
 * PM rulings this encodes:
 * - a workspace whose only member is this user is deleted with the account;
 * - 409 ONLY for a workspace with other members where the user is the sole
 *   owner (someone else must take ownership first);
 * - an active paid subscription owned by the user must be cancelled first;
 * - security events survive 90 days (configurable) with user id / email
 *   replaced by HMACs and the IP truncated, then housekeeping purges them;
 * - decision records keep the reviewer's comment text verbatim; only the
 *   name, email and device are anonymised.
 */

import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { CLOUD_PLANS } from '@hitly/core'
import { DELETION_CONFIRMATION_WORD } from './account-deletion'

// ---------------------------------------------------------------------------
// Typed confirmation
// ---------------------------------------------------------------------------

/** Surrounding whitespace is tolerated; case and any other character are not. */
export function isDeletionConfirmation(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === DELETION_CONFIRMATION_WORD
}

// ---------------------------------------------------------------------------
// Workspace classification
// ---------------------------------------------------------------------------

export type DeletionWorkspaceInput = {
  id: string
  name: string
  /** The deleting user's role in this workspace. */
  role: string
  /** Total members of the workspace, including this user. */
  memberCount: number
  /** True when the deleting user is the only member with the owner role. */
  soleOwner: boolean
  plan: string
  stripeSubscriptionId: string | null
}

export type BlockedReason = 'sole_owner_of_shared' | 'active_subscription'

export type BlockedWorkspace = {
  id: string
  name: string
  reason: BlockedReason
}

export type AccountDeletionPlan = {
  /** Deleted together with the account (this user is the only member). */
  deletableWorkspaces: Array<{ id: string; name: string }>
  /** Kept: the user's membership row simply disappears with the account. */
  keptWorkspaces: Array<{ id: string; name: string; role: string }>
  /** Deletion refuses to run while this list is non-empty. */
  blockedWorkspaces: BlockedWorkspace[]
  hasBlocker: boolean
}

/** A workspace with other members that this user alone owns must be handed over. */
export function blocksAsSoleOwnerOfShared(workspace: DeletionWorkspaceInput): boolean {
  return workspace.memberCount > 1 && workspace.role === 'owner' && workspace.soleOwner
}

/**
 * An active paid subscription owned by this user must be cancelled first.
 *
 * Owned means: the user is an owner of the workspace, the workspace carries a
 * Stripe subscription id, and its plan is one of the paid Cloud plans.
 *
 * TODO(billing): the open-source edition has no Stripe integration, so the
 * subscription is inferred from the workspace row (the only place the OSS
 * schema records it). When a Stripe integration is wired into this repo, the
 * check should ask Stripe for the live subscription status of the customer
 * behind `stripeCustomerId` instead of trusting the cached plan, and should
 * also cover subscriptions billed on a user-level customer. Stripe customer
 * and invoice records themselves are out of scope for account deletion.
 */
export function hasActivePaidSubscriptionOwned(workspace: DeletionWorkspaceInput): boolean {
  if (workspace.role !== 'owner') return false
  if (!workspace.stripeSubscriptionId) return false
  return (CLOUD_PLANS as readonly string[]).includes(workspace.plan)
}

/**
 * Split the user's workspaces into delete-with-account / keep / blocked.
 *
 * A single-member workspace goes with the account (ruling: projects, keys and
 * data go too — the UI must show this and offer an export first). Anything
 * with other members survives; the membership row is removed by the FK
 * cascade. A blocked workspace outranks both buckets: nothing is deleted
 * until the blocker is resolved.
 */
export function planAccountDeletion(workspaces: readonly DeletionWorkspaceInput[]): AccountDeletionPlan {
  const deletableWorkspaces: AccountDeletionPlan['deletableWorkspaces'] = []
  const keptWorkspaces: AccountDeletionPlan['keptWorkspaces'] = []
  const blockedWorkspaces: BlockedWorkspace[] = []

  for (const workspace of workspaces) {
    if (blocksAsSoleOwnerOfShared(workspace)) {
      blockedWorkspaces.push({ id: workspace.id, name: workspace.name, reason: 'sole_owner_of_shared' })
      continue
    }
    if (hasActivePaidSubscriptionOwned(workspace)) {
      blockedWorkspaces.push({ id: workspace.id, name: workspace.name, reason: 'active_subscription' })
      continue
    }
    if (workspace.memberCount <= 1) {
      deletableWorkspaces.push({ id: workspace.id, name: workspace.name })
      continue
    }
    keptWorkspaces.push({ id: workspace.id, name: workspace.name, role: workspace.role })
  }

  return {
    deletableWorkspaces,
    keptWorkspaces,
    blockedWorkspaces,
    hasBlocker: blockedWorkspaces.length > 0,
  }
}

/** Human line shown for a blocked workspace in the confirmation step. */
export function blockedWorkspaceMessage(reason: BlockedReason): string {
  if (reason === 'active_subscription') {
    return 'Cancel your subscription first — a workspace you own still has an active paid plan.'
  }
  return 'Make someone else the owner of this workspace first — it has other members.'
}

/** Workspace roles that must hear about a member deleting their account. */
export const API_KEY_REVIEW_ROLES: readonly string[] = ['owner', 'admin']

export function shouldNotifyWorkspaceAdmin(role: string): boolean {
  return API_KEY_REVIEW_ROLES.includes(role)
}

/**
 * API keys of a surviving (shared) workspace stay; the admins are emailed to
 * review them, because a key that only the deleted member used has no owner
 * left. Keys inside a deleted sole-member workspace are gone with the
 * workspace cascade, so no notice is needed for those.
 */
export function needsApiKeyReviewNotice(plan: AccountDeletionPlan): boolean {
  return plan.keptWorkspaces.length > 0
}

// ---------------------------------------------------------------------------
// Security-event anonymisation
// ---------------------------------------------------------------------------

/** PM ruling: 90 days, then housekeeping purges. Operators may change it. */
export const DEFAULT_SECURITY_EVENT_RETENTION_DAYS = 90
const MAX_SECURITY_EVENT_RETENTION_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

/** HITLY_SECURITY_EVENT_RETENTION_DAYS: whole days, 1-3650, default 90. */
export function securityEventRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HITLY_SECURITY_EVENT_RETENTION_DAYS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SECURITY_EVENT_RETENTION_DAYS
  const days = Number(raw)
  if (days < 1 || days > MAX_SECURITY_EVENT_RETENTION_DAYS) return DEFAULT_SECURITY_EVENT_RETENTION_DAYS
  return days
}

export function securityEventRetentionExpiresAt(
  retentionDays: number,
  now: number = Date.now(),
): Date {
  return new Date(now + retentionDays * DAY_MS)
}

/**
 * Key for the security-event HMACs. Set HITLY_SECURITY_EVENT_HMAC_KEY to a
 * value the operator can keep stable across restarts (rotating it breaks the
 * ability to correlate events with a known user, which is the point).
 * Falls back to the auth secret; the domain-separated message below means the
 * two HMACs can never collide with anything else the auth secret signs.
 */
export const SECURITY_EVENT_HMAC_KEY_MIN_LENGTH = 16
export const SECURITY_EVENT_HMAC_DOMAIN = 'hitly:security-event:v1'

export function securityEventHmacKeyProblem(value: string | undefined): string | null {
  const key = (value ?? '').trim()
  if (!key) return 'no key configured'
  if (key.length < SECURITY_EVENT_HMAC_KEY_MIN_LENGTH) {
    return `key must be at least ${SECURITY_EVENT_HMAC_KEY_MIN_LENGTH} characters`
  }
  return null
}

export function resolveSecurityEventHmacKey(
  env: Record<string, string | undefined> = process.env,
  fallback?: string,
): string {
  const configured = (env.HITLY_SECURITY_EVENT_HMAC_KEY ?? '').trim()
  if (securityEventHmacKeyProblem(configured) === null) return configured
  const derived = (fallback ?? env.BETTER_AUTH_SECRET ?? '').trim()
  if (securityEventHmacKeyProblem(derived) === null) return derived
  throw new Error(
    `security-event HMAC key unavailable: ${securityEventHmacKeyProblem(configured)} and ${securityEventHmacKeyProblem(derived)}`,
  )
}

/** Domain-separated HMAC-SHA256 (hex) so a leaked value cannot be reversed. */
export function securityEventHmac(key: string, value: string): string {
  return createHmac('sha256', key).update(`${SECURITY_EVENT_HMAC_DOMAIN}:${value}`, 'utf8').digest('hex')
}

/**
 * Drop the host part of a client address: /24 for IPv4, /64 for IPv6.
 * Anything that is not a parseable IP becomes null — an unparseable value is
 * never stored.
 */
export function truncateIpAddress(value: string | null | undefined): string | null {
  const address = (value ?? '').trim()
  if (!address) return null
  const version = isIP(address)
  if (version === 4) {
    const parts = address.split('.')
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`
  }
  if (version === 6) {
    const groups = expandIpv6(address)
    if (!groups) return null
    // Keep the /64 (the provider-assigned site prefix), zero the interface half.
    return groups.slice(0, 4).map((group) => group.toString(16)).join(':') + '::'
  }
  return null
}

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase()
  const mapped = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (mapped) {
    const [a, b, c, d] = mapped.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, -mapped[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail].map((group) =>
    Number.parseInt(group, 16),
  )
  if (groups.length !== 8 || groups.some((group) => !Number.isFinite(group) || group < 0 || group > 0xffff)) {
    return null
  }
  return groups
}

// ---------------------------------------------------------------------------
// Decision-record anonymisation
// ---------------------------------------------------------------------------

/** What the UI shows once the reviewer's account is gone. */
export const DELETED_USER_LABEL = 'Deleted user'

export type StoredDecisionActor = { kind?: string; id?: string; display?: string }
export type StoredDecisionClient = {
  channel?: string
  platform?: string
  appVersion?: string
  userAgent?: string
  [key: string]: unknown
}
export type StoredDecisionContext = {
  client?: StoredDecisionClient
  actor?: StoredDecisionActor
  [key: string]: unknown
}

/**
 * Anonymise the stored decide-time context of a decision record.
 *
 * Kept: the decision itself and everything under `payload` (the reviewer's
 * comment text: reason / response / editReason / answer) — that is handled by
 * simply never touching `payload`.
 *
 * Removed: the reviewer's identity and device. `actor.id` is a user id (the
 * account no longer exists) and `actor.display` is their name or email; both
 * collapse to the fixed "Deleted user" label so the audit trail still reads
 * as a human decision. `client.userAgent`, `platform`, `appVersion` and any
 * other device-ish field are dropped; the channel stays because it is a
 * property of the request path, not of the person.
 *
 * Returns a fresh object; the input is never mutated.
 */
export function anonymiseDecisionContext(context: StoredDecisionContext | null | undefined): StoredDecisionContext {
  if (!context || typeof context !== 'object') return {}
  const next: StoredDecisionContext = {}
  for (const [key, value] of Object.entries(context)) {
    if (key === 'actor') {
      // No `id`: the account is gone, and an empty id used to leak into the
      // evidence chain (hitly#97 S97-S4). The label is all that is left.
      next.actor = { kind: 'human', display: DELETED_USER_LABEL }
      continue
    }
    if (key === 'client' && value && typeof value === 'object') {
      const client = value as StoredDecisionClient
      const channel = typeof client.channel === 'string' ? client.channel : undefined
      next.client = { ...(channel ? { channel } : {}) }
      continue
    }
    if (key === 'payload') continue // payload is a separate column; never copied here
    next[key] = value
  }
  return next
}

/**
 * True when a stored context still carries anything identifying: a user id, a
 * user agent, an app version or a platform. The redacted shape
 * (`{actor:{kind,display}, client:{channel}}`) must answer false, so this
 * checks the identity-bearing keys/values, not the mere presence of `display`.
 */
export function contextCarriesIdentity(context: StoredDecisionContext | null | undefined): boolean {
  if (!context || typeof context !== 'object') return false
  const text = JSON.stringify(context).toLowerCase()
  return (
    text.includes('useragent') ||
    text.includes('appversion') ||
    text.includes('"platform"') ||
    text.includes('"id"')
  )
}
