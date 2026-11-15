/**
 * The server half of account deletion: the handlers behind
 * /api/session/delete-account* and /api/session/export.
 *
 * Rules (PM rulings for HG-5 PR B) and where they are enforced:
 * - WHAT goes and WHAT is anonymised is decided by lib/account-deletion-plan.ts;
 *   this file only executes that plan against Postgres.
 * - Re-auth (current password or a user-verified passkey) mints a single-use
 *   ticket; the delete handler consumes it, so the irreversible call always
 *   follows a fresh proof and can never be replayed.
 * - The typed confirmation is re-checked server-side, never trusted from the UI.
 * - Blockers are re-checked at delete time, not only in the preview, so a
 *   workspace shared or a subscription started after the preview still blocks.
 * - Everything destructive happens inside ONE transaction: either the account
 *   and its rulings land together, or nothing changes.
 * - The account-deleted confirmation and the API-key review notices are sent
 *   only after COMMIT, and never block the reply.
 *
 * Nothing here logs a password, a token or an email address: failures are
 * logged as fixed lines.
 */

import { createHash, randomBytes } from 'node:crypto'
import { and, count, eq, inArray, ne } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { isAPIError } from 'better-auth/api'
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server'
import { base64 } from '@better-auth/utils/base64'
import { edition } from '@hitly/cloud'
import {
  accountSecurityEvents,
  approvals,
  decisionRecords,
  evidenceReceipts,
  invites,
  memberships,
  passkeys,
  pendingEmailChanges,
  pendingEmailVerifications,
  projectApiKeys,
  projectChannels,
  projectEvents,
  projectMemberships,
  projectRules,
  projects,
  users,
  verifications,
  workspaces,
  workspaceOtelEndpoints,
} from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { newId } from './ids'
import { clientAddress } from './client-address'
import { resetCheckClientKey } from './reset-check-limit'
import { sendMail } from './mail'
import { webAuthnRelyingParty } from './webauthn-rp'
import { assertionHasUserVerification } from './passkey'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'
import {
  blockedWorkspaceMessage,
  planAccountDeletion,
  anonymiseDecisionContext,
  isDeletionConfirmation,
  resolveSecurityEventHmacKey,
  securityEventHmac,
  securityEventRetentionDays,
  securityEventRetentionExpiresAt,
  shouldNotifyWorkspaceAdmin,
  truncateIpAddress,
  type AccountDeletionPlan,
  type DeletionWorkspaceInput,
} from './account-deletion-plan'
import {
  DELETION_CHALLENGE_COOKIE,
  DELETION_CHALLENGE_TTL_MS,
  DELETION_TICKET_TTL_MS,
  type DeletionPreview,
} from './account-deletion'
import {
  DELETION_CONFIRM_LIMITED_LOG,
  DELETION_REAUTH_LIMITED_LOG,
  deletionConfirmLimiter,
  deletionReauthLimiter,
} from './account-deletion-limit'
import { createSendAccountDeletedEmail, createSendApiKeyReviewNotice } from './account-deletion-emails'
import type { MailFn } from './password-reset'

type Database = NonNullable<typeof db>
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export const ACCOUNT_DELETION_SECURITY_EVENT = 'account_deleted'
export const ACCOUNT_DELETED_LOG = '[hitly account-deletion] account_deleted'

const TICKET_PREFIX = 'account-deletion:ticket:'
const ASSERTION_PREFIX = 'account-deletion:assertion:'
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/

export type DeletionSessionUser = { id: string; email: string; name?: string | null }

export interface DeletionRouteDeps {
  getSessionUser?: (headers: Headers) => Promise<DeletionSessionUser | null>
  verifyPassword?: (headers: Headers, password: string) => Promise<boolean>
  clientKey?: (headers: Headers) => string
  allowReauth?: (key: string) => boolean
  allowConfirm?: (key: string) => boolean
  clientAddressOf?: (headers: Headers) => string | null
  now?: () => number
  database?: Database
  generateAuthenticationOptions?: typeof generateAuthenticationOptions
  verifyAuthenticationResponse?: typeof verifyAuthenticationResponse
  notifyDeleted?: (args: { to: string }) => Promise<void>
  notifyApiKeyReview?: (args: { to: string; workspaceName: string }) => Promise<void>
  /** Mail transport for the default branded notices. */
  sendMail?: MailFn
  log?: (line: string) => void
}

function json(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status })
  response.headers.set('cache-control', 'no-store')
  response.headers.set('referrer-policy', 'no-referrer')
  return response
}

function requireDatabase(database: Database | undefined): Database {
  const resolved = database ?? db
  if (!resolved) throw new Error('DATABASE_URL is not set')
  return resolved
}

function rowId(prefix: string) {
  return newId(prefix).slice(0, 36)
}

/** 256 bits from the OS CSPRNG, base64url (43 characters). */
export function generateDeletionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashDeletionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function isWellFormedDeletionToken(token: unknown): token is string {
  return typeof token === 'string' && TICKET_SHAPE.test(token)
}

type StoredTicket = { type: 'deletion-ticket'; userId: string }
type StoredAssertion = { type: 'deletion-assertion'; expectedChallenge: string; userId: string }

/**
 * Single-statement consume: DELETE ... RETURNING, so two concurrent requests
 * can never both redeem the same ticket or challenge.
 */
export async function consumeDeletionVerification(
  database: Database,
  identifier: string,
  nowMs: number,
): Promise<Record<string, unknown> | null> {
  const rows = await database.delete(verifications).where(eq(verifications.identifier, identifier)).returning()
  const row = rows[0]
  if (!row || row.expiresAt.getTime() <= nowMs) return null
  try {
    const stored = JSON.parse(row.value) as Record<string, unknown>
    return stored ?? null
  } catch {
    return null
  }
}

async function defaultGetSessionUser(headers: Headers): Promise<DeletionSessionUser | null> {
  if (!auth) return null
  const session = await auth.api.getSession({ headers })
  return session?.user ? { id: session.user.id, email: session.user.email, name: session.user.name } : null
}

async function defaultVerifyPassword(headers: Headers, password: string): Promise<boolean> {
  if (!auth) throw new Error('auth unavailable')
  try {
    const result = (await auth.api.verifyPassword({
      headers,
      body: { password },
      asResponse: true,
    })) as unknown as Response
    return result.status === 200
  } catch (error) {
    if (isAPIError(error)) return false
    throw error
  }
}

type RequestLike = { headers: Headers; json: () => Promise<unknown> }

/** Session + database prelude shared by every handler; fixed-line logging only. */
async function requireSession(
  request: RequestLike,
  deps: DeletionRouteDeps,
): Promise<{ user: DeletionSessionUser; database: Database } | NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const getSessionUser = deps.getSessionUser ?? defaultGetSessionUser
  let user: DeletionSessionUser | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    log(`[hitly account-deletion] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'deletion_failed' }, 500)
  }
  if (!user) return json({ error: 'unauthorized' }, 401)
  try {
    return { user, database: requireDatabase(deps.database) }
  } catch {
    log('[hitly account-deletion] Database is not configured')
    return json({ error: 'deletion_failed' }, 500)
  }
}

/** Member count + sole-owner flag for one workspace, from the membership table. */
async function workspaceShape(
  database: Database | Tx,
  workspaceId: string,
  userId: string,
): Promise<{ memberCount: number; soleOwner: boolean }> {
  const members = await database
    .select({ value: count() })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId))
  const otherOwners = await database
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, 'owner'),
        ne(memberships.userId, userId),
      ),
    )
    .limit(1)
  return { memberCount: Number(members[0]?.value ?? 0), soleOwner: otherOwners.length === 0 }
}

/** The deleting user's workspaces, measured, in the shape the planner wants. */
export async function collectWorkspaceInputs(
  database: Database | Tx,
  userId: string,
): Promise<DeletionWorkspaceInput[]> {
  const rows = await database
    .select({
      id: workspaces.id,
      name: workspaces.name,
      plan: workspaces.plan,
      role: memberships.role,
      stripeSubscriptionId: workspaces.stripeSubscriptionId,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(eq(memberships.userId, userId))
  const inputs: DeletionWorkspaceInput[] = []
  for (const row of rows) {
    const shape = await workspaceShape(database, row.id, userId)
    inputs.push({
      id: row.id,
      name: row.name,
      role: row.role,
      memberCount: shape.memberCount,
      soleOwner: shape.soleOwner,
      plan: row.plan,
      stripeSubscriptionId: row.stripeSubscriptionId,
    })
  }
  return inputs
}

async function countByWorkspace(database: Database | Tx, workspaceId: string) {
  const projectsRows = await database
    .select({ value: count() })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
  const keysRows = await database
    .select({ value: count() })
    .from(projectApiKeys)
    .where(eq(projectApiKeys.workspaceId, workspaceId))
  const decisionRows = await database
    .select({ value: count() })
    .from(decisionRecords)
    .where(eq(decisionRecords.workspaceId, workspaceId))
  return {
    projects: Number(projectsRows[0]?.value ?? 0),
    apiKeys: Number(keysRows[0]?.value ?? 0),
    decisions: Number(decisionRows[0]?.value ?? 0),
  }
}

/** Admins (owner/admin, excluding the deleting user) of the surviving workspaces. */
async function apiKeyReviewRecipients(
  database: Database | Tx,
  keptWorkspaceIds: string[],
  deletingUserId: string,
): Promise<Array<{ email: string; workspaceName: string }>> {
  if (keptWorkspaceIds.length === 0) return []
  const rows = await database
    .select({
      email: users.email,
      workspaceName: workspaces.name,
      workspaceId: memberships.workspaceId,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(and(inArray(memberships.workspaceId, keptWorkspaceIds), ne(memberships.userId, deletingUserId)))
  const seen = new Set<string>()
  const recipients: Array<{ email: string; workspaceName: string }> = []
  for (const row of rows) {
    if (!shouldNotifyWorkspaceAdmin(row.role)) continue
    const key = `${row.workspaceId}:${row.email.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    recipients.push({ email: row.email, workspaceName: row.workspaceName })
  }
  return recipients
}

// ---------------------------------------------------------------------------
// GET /api/session/delete-account/preview
// ---------------------------------------------------------------------------

/**
 * The confirmation summary for one user, from the plan: which workspaces go
 * with the account (with their project / API-key / decision counts so the user
 * can see the damage), which survive, and whether a blocker refuses the run.
 * Shared by the preview endpoint and the settings page that renders it.
 */
export async function buildDeletionPreview(database: Database, userId: string): Promise<DeletionPreview> {
  const inputs = await collectWorkspaceInputs(database, userId)
  const plan = planAccountDeletion(inputs)

  const deletable: DeletionPreview['deletableWorkspaces'] = []
  for (const workspace of plan.deletableWorkspaces) {
    const counts = await countByWorkspace(database, workspace.id)
    deletable.push({ id: workspace.id, name: workspace.name, ...counts })
  }
  const kept: DeletionPreview['keptWorkspaces'] = []
  for (const workspace of plan.keptWorkspaces) {
    const keys = await database
      .select({ value: count() })
      .from(projectApiKeys)
      .where(eq(projectApiKeys.workspaceId, workspace.id))
    kept.push({
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      apiKeys: Number(keys[0]?.value ?? 0),
    })
  }

  return {
    deletableWorkspaces: deletable,
    keptWorkspaces: kept,
    blockedWorkspaces: plan.blockedWorkspaces.map((blocked) => ({
      id: blocked.id,
      name: blocked.name,
      reason: blocked.reason,
      message: blockedWorkspaceMessage(blocked.reason),
    })),
    hasBlocker: plan.hasBlocker,
    exportAvailable: plan.deletableWorkspaces.length > 0,
  }
}

/** Server-component entry: the summary for the signed-in user. */
export async function loadDeletionPreview(userId: string, deps: DeletionRouteDeps = {}): Promise<DeletionPreview> {
  return buildDeletionPreview(requireDatabase(deps.database), userId)
}

/**
 * What the confirmation step renders (GET /api/session/delete-account/preview).
 */
export async function handleDeletionPreview(
  request: RequestLike,
  deps: DeletionRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  try {
    return json(await buildDeletionPreview(database, user.id))
  } catch (error) {
    log(`[hitly account-deletion] Could not build the preview: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'deletion_failed' }, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/session/export  ("export first")
// ---------------------------------------------------------------------------

function redactSecrets(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const redacted: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = typeof entry === 'string' ? '[redacted]' : entry !== null && typeof entry === 'object' ? '[redacted]' : entry
  }
  return redacted
}

/**
 * JSON export of everything the account takes with it.
 *
 * Scoped to what belongs to THIS user alone: their profile and the contents of
 * the sole-member workspaces that the deletion destroys. Data in a shared
 * workspace belongs to the remaining members and is deliberately not exported
 * (only the membership itself is listed). Tenant-encrypted columns are decoded
 * with the workspace key, and project credentials — which hold third-party
 * secrets — are redacted to key names. API keys export their metadata only;
 * a hash is never a usable secret but it is still not exported.
 */
export async function handleAccountExport(
  request: RequestLike,
  deps: DeletionRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared

  try {
    const profileRows = await database
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    const profile = profileRows[0]
    if (!profile) return json({ error: 'unauthorized' }, 401)

    const inputs = await collectWorkspaceInputs(database, user.id)
    const plan = planAccountDeletion(inputs)
    const soleMemberIds = plan.deletableWorkspaces.map((workspace) => workspace.id)

    const exportedWorkspaces: Array<Record<string, unknown>> = []
    for (const workspaceId of soleMemberIds) {
      const workspaceRows = await database
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
      const workspaceRow = workspaceRows[0]
      if (!workspaceRow) continue

      const projectRows = await database.select().from(projects).where(eq(projects.workspaceId, workspaceId))
      const decodedProjects = []
      for (const project of projectRows) {
        decodedProjects.push({
          id: project.id,
          name: project.name,
          description: project.description,
          plugin: project.plugin,
          status: project.status,
          defaultSlaMinutes: project.defaultSlaMinutes,
          evidenceSinkType: project.evidenceSinkType,
          credentials: redactSecrets(await decodeTenantJson(workspaceId, project.credentials as never)),
          createdAt: project.createdAt.toISOString(),
        })
      }

      const ruleRows = await database.select().from(projectRules).where(eq(projectRules.workspaceId, workspaceId))
      const channelRows = await database
        .select()
        .from(projectChannels)
        .where(eq(projectChannels.workspaceId, workspaceId))
      const approvalRows = await database.select().from(approvals).where(eq(approvals.workspaceId, workspaceId))
      const decisionRows = await database
        .select()
        .from(decisionRecords)
        .where(eq(decisionRecords.workspaceId, workspaceId))
      const keyRows = await database.select().from(projectApiKeys).where(eq(projectApiKeys.workspaceId, workspaceId))

      exportedWorkspaces.push({
        id: workspaceRow.id,
        name: workspaceRow.name,
        slug: workspaceRow.slug,
        timezone: workspaceRow.timezone,
        plan: workspaceRow.plan,
        projects: decodedProjects,
        rules: ruleRows.map((rule) => ({
          id: rule.id,
          projectId: rule.projectId,
          name: rule.name,
          priority: rule.priority,
          enabled: rule.enabled,
          match: rule.match,
          actions: rule.actions,
        })),
        channels: await Promise.all(
          channelRows.map(async (channel) => ({
            id: channel.id,
            projectId: channel.projectId,
            type: channel.type,
            enabled: channel.enabled,
            config: redactSecrets(await decodeTenantJson(workspaceId, channel.config as never)),
          })),
        ),
        approvals: await Promise.all(
          approvalRows.map(async (approval) => ({
            id: approval.id,
            projectId: approval.projectId,
            plugin: approval.plugin,
            status: approval.status,
            actionName: approval.actionName,
            envelope: await decodeTenantJson(workspaceId, approval.envelope as never),
            createdAt: approval.createdAt.toISOString(),
          })),
        ),
        decisionRecords: await Promise.all(
          decisionRows.map(async (record) => ({
            id: record.id,
            approvalId: record.approvalId,
            decision: record.decision,
            payload: await decodeTenantJson(workspaceId, record.payload as never),
            createdAt: record.createdAt.toISOString(),
          })),
        ),
        apiKeys: keyRows.map((key) => ({
          id: key.id,
          projectId: key.projectId,
          name: key.name,
          prefix: key.prefix,
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
          createdAt: key.createdAt.toISOString(),
        })),
      })
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      profile,
      // Workspaces the user shared with others survive; only the membership goes.
      memberships: plan.keptWorkspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        role: workspace.role,
        dataExported: false,
      })),
      workspaces: exportedWorkspaces,
      blockers: plan.blockedWorkspaces,
    }
    const response = new NextResponse(JSON.stringify(payload, null, 2), { status: 200 })
    response.headers.set('content-type', 'application/json; charset=utf-8')
    response.headers.set('content-disposition', 'attachment; filename="hitly-account-export.json"')
    response.headers.set('cache-control', 'no-store')
    response.headers.set('referrer-policy', 'no-referrer')
    return response
  } catch (error) {
    log(`[hitly account-deletion] Could not build the export: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'export_failed' }, 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/session/delete-account/reauth/options  (passkey assertion)
// ---------------------------------------------------------------------------

function setChallengeCookie(response: NextResponse, token: string) {
  const secure = process.env.NODE_ENV === 'production'
  response.cookies.set(DELETION_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(DELETION_CHALLENGE_TTL_MS / 1000),
    secure,
  })
}

function expireChallengeCookie(response: NextResponse) {
  const parts = [
    `${DELETION_CHALLENGE_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  response.headers.append('set-cookie', parts.join('; '))
}

function readChallengeCookie(headers: Headers): string {
  const raw = headers.get('cookie') ?? ''
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(`${DELETION_CHALLENGE_COOKIE}=`)) continue
    return decodeURIComponent(trimmed.slice(`${DELETION_CHALLENGE_COOKIE}=`.length))
  }
  return ''
}

/**
 * WebAuthn assertion options for the caller's own passkeys. A UV passkey is a
 * valid re-auth for deletion, so the options pin `allowCredentials` to this
 * user's credentials and the challenge is stored hashed, bound to their id,
 * five minutes, single use.
 */
export async function handleDeletionReauthOptions(
  request: RequestLike,
  deps: DeletionRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  const now = deps.now ?? Date.now

  try {
    const credentials = await database.select().from(passkeys).where(eq(passkeys.userId, user.id))
    if (credentials.length === 0) return json({ code: 'NO_PASSKEY' }, 400)
    const generate = deps.generateAuthenticationOptions ?? generateAuthenticationOptions
    const rp = webAuthnRelyingParty()
    const options = await generate({
      rpID: rp.rpID,
      userVerification: 'required',
      allowCredentials: credentials.map((credential) => ({ id: credential.credentialID })),
    })
    const token = generateDeletionToken()
    const stored: StoredAssertion = { type: 'deletion-assertion', expectedChallenge: options.challenge, userId: user.id }
    await database.insert(verifications).values({
      id: rowId('del'),
      identifier: `${ASSERTION_PREFIX}${hashDeletionToken(token)}`,
      value: JSON.stringify(stored),
      expiresAt: new Date(now() + DELETION_CHALLENGE_TTL_MS),
    })
    const response = json(options)
    setChallengeCookie(response, token)
    return response
  } catch (error) {
    log(`[hitly account-deletion] Could not start passkey re-auth: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'deletion_failed' }, 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/session/delete-account/reauth
// ---------------------------------------------------------------------------

function ticketResponse(userId: string, database: Database, nowMs: number): Promise<NextResponse> {
  const ticket = generateDeletionToken()
  const stored: StoredTicket = { type: 'deletion-ticket', userId }
  return database
    .insert(verifications)
    .values({
      id: rowId('del'),
      identifier: `${TICKET_PREFIX}${hashDeletionToken(ticket)}`,
      value: JSON.stringify(stored),
      expiresAt: new Date(nowMs + DELETION_TICKET_TTL_MS),
    })
    .then(() => {
      const response = json({ ok: true, ticket, expiresInSec: Math.floor(DELETION_TICKET_TTL_MS / 1000) })
      expireChallengeCookie(response)
      return response
    })
}

/**
 * Re-auth for the irreversible call. Two accepted methods:
 * - `password`: Better Auth's verifyPassword helper;
 * - `passkey`: a WebAuthn assertion against one of THIS user's credentials,
 *   which must carry the user-verification flag (a UV passkey counts as a
 *   phishing-resistant second factor, so it is a valid re-auth).
 *
 * Either mints a single-use five-minute ticket bound to the user id. A wrong
 * password or a failed/unbound/UV-less assertion changes nothing and answers
 * the same fixed codes; the attempt limiter is spent before any checking.
 */
export async function handleDeletionReauth(
  request: RequestLike,
  deps: DeletionRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  const now = deps.now ?? Date.now

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const method = body.method

  const allow = deps.allowReauth ?? deletionReauthLimiter
  const clientKey = deps.clientKey ?? resetCheckClientKey
  if (!allow(clientKey(request.headers))) {
    log(DELETION_REAUTH_LIMITED_LOG)
    return json({ error: 'too_many_attempts' }, 429)
  }

  if (method === 'password') {
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    if (!currentPassword) return json({ code: 'MISSING_FIELDS' }, 400)
    const verifyPassword = deps.verifyPassword ?? defaultVerifyPassword
    let ok: boolean
    try {
      ok = await verifyPassword(request.headers, currentPassword)
    } catch {
      log('[hitly account-deletion] Password verification failed with an unexpected error')
      return json({ error: 'deletion_failed' }, 500)
    }
    if (!ok) return json({ code: 'INVALID_PASSWORD' }, 400)
    return ticketResponse(user.id, database, now())
  }

  if (method === 'passkey') {
    const attestation = body.response as AuthenticationResponseJSON | undefined
    if (!attestation || typeof attestation !== 'object' || typeof attestation.id !== 'string') {
      return json({ error: 'invalid_response' }, 400)
    }
    // Fail closed BEFORE anything is read: an assertion without the UV flag is
    // not a multi-factor proof and never re-authorises a deletion.
    if (!assertionHasUserVerification(attestation)) {
      return json({ error: 'verification_failed', code: 'USER_VERIFICATION_REQUIRED' }, 400)
    }
    const token = readChallengeCookie(request.headers)
    if (!token) {
      const missing = json({ error: 'challenge_not_found' }, 400)
      expireChallengeCookie(missing)
      return missing
    }
    let stored: StoredAssertion | null = null
    try {
      const consumed = await consumeDeletionVerification(
        database,
        `${ASSERTION_PREFIX}${hashDeletionToken(token)}`,
        now(),
      )
      if (consumed && consumed.type === 'deletion-assertion') stored = consumed as unknown as StoredAssertion
    } catch (error) {
      log(`[hitly account-deletion] Could not consume the assertion challenge: ${error instanceof Error ? error.name : 'error'}`)
      const failed = json({ error: 'deletion_failed' }, 500)
      expireChallengeCookie(failed)
      return failed
    }
    // The challenge is bound to the user: another account's challenge is worth
    // nothing here, and no existence is disclosed either way.
    if (!stored || stored.userId !== user.id) {
      const expired = json({ error: 'challenge_not_found' }, 400)
      expireChallengeCookie(expired)
      return expired
    }

    const credentialRows = await database
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.credentialID, attestation.id), eq(passkeys.userId, user.id)))
      .limit(1)
    const credential = credentialRows[0]
    if (!credential) {
      const rejected = json({ error: 'verification_failed' }, 400)
      expireChallengeCookie(rejected)
      return rejected
    }

    const verify = deps.verifyAuthenticationResponse ?? verifyAuthenticationResponse
    const rp = webAuthnRelyingParty()
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verified = await verify({
        response: attestation,
        expectedChallenge: stored.expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credentialID,
          counter: credential.counter,
          publicKey: base64.decode(credential.publicKey),
        },
      })
    } catch {
      const failed = json({ error: 'verification_failed' }, 400)
      expireChallengeCookie(failed)
      return failed
    }
    if (!verified.verified || !verified.authenticationInfo) {
      const failed = json({ error: 'verification_failed' }, 400)
      expireChallengeCookie(failed)
      return failed
    }
    try {
      await database
        .update(passkeys)
        .set({ counter: verified.authenticationInfo.newCounter, lastUsedAt: new Date() })
        .where(eq(passkeys.id, credential.id))
    } catch {
      // Counter sync is best-effort; the proof already succeeded.
    }
    return ticketResponse(user.id, database, now())
  }

  return json({ code: 'MISSING_FIELDS' }, 400)
}

// ---------------------------------------------------------------------------
// POST /api/session/delete-account
// ---------------------------------------------------------------------------

/** Tenant tables of a workspace, deleted explicitly (RLS-safe) before its row. */
async function deleteWorkspaceContents(tx: Tx, workspaceId: string) {
  await tx.delete(decisionRecords).where(eq(decisionRecords.workspaceId, workspaceId))
  await tx.delete(evidenceReceipts).where(eq(evidenceReceipts.workspaceId, workspaceId))
  await tx.delete(projectEvents).where(eq(projectEvents.workspaceId, workspaceId))
  await tx.delete(approvals).where(eq(approvals.workspaceId, workspaceId))
  await tx.delete(projectChannels).where(eq(projectChannels.workspaceId, workspaceId))
  await tx.delete(projectRules).where(eq(projectRules.workspaceId, workspaceId))
  await tx.delete(projectApiKeys).where(eq(projectApiKeys.workspaceId, workspaceId))
  await tx.delete(projectMemberships).where(eq(projectMemberships.workspaceId, workspaceId))
  await tx.delete(workspaceOtelEndpoints).where(eq(workspaceOtelEndpoints.workspaceId, workspaceId))
  await tx.delete(projects).where(eq(projects.workspaceId, workspaceId))
  await tx.delete(workspaces).where(eq(workspaces.id, workspaceId))
}

/**
 * Anonymise the deleting user's decision records in the workspaces that
 * survive. `payload` (the reviewer's comment text) is never touched; the
 * tenant-encrypted decide-time context is decoded, stripped of identity and
 * device, re-encoded, and `actor_user_id` is cleared so every reader shows the
 * fixed "Deleted user" label.
 */
async function anonymiseDecisionRecords(tx: Tx, userId: string, keptWorkspaceIds: string[]) {
  if (keptWorkspaceIds.length === 0) return
  const rows = await tx
    .select({ id: decisionRecords.id, workspaceId: decisionRecords.workspaceId, client: decisionRecords.client })
    .from(decisionRecords)
    .where(
      and(
        eq(decisionRecords.actorUserId, userId),
        keptWorkspaceIds.length === 1
          ? eq(decisionRecords.workspaceId, keptWorkspaceIds[0]!)
          : inArray(decisionRecords.workspaceId, keptWorkspaceIds),
      ),
    )
  for (const row of rows) {
    const redacted = row.client
      ? await encodeTenantJson(
          row.workspaceId,
          anonymiseDecisionContext(
            (await decodeTenantJson(row.workspaceId, row.client as never)) as Record<string, unknown>,
          ) as never,
        )
      : null
    await tx
      .update(decisionRecords)
      .set({ actorUserId: null, client: redacted as never })
      .where(eq(decisionRecords.id, row.id))
  }
}

/**
 * The irreversible handler.
 *
 * Guards, in order, all of them re-derived server-side:
 * 1. session, 2. typed confirmation equals DELETE exactly, 3. a fresh,
 * unspent, correctly-bound re-auth ticket, 4. no blocker (sole owner of a
 * shared workspace, active paid subscription). Then one transaction:
 * anonymise decision records, anonymise security events, drop pending email
 * tokens and invites addressed to this user, delete the sole-member
 * workspaces, delete the user. Then, after COMMIT, the confirmation email and
 * the API-key review notices.
 *
 * Idempotent: a repeat call for an account that is already gone answers
 * { ok: true, alreadyDeleted: true } rather than 500.
 */
export async function handleAccountDeletion(
  request: RequestLike,
  deps: DeletionRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  const now = deps.now ?? Date.now

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const confirmation = body.confirmation
  const ticket = body.ticket

  if (!isDeletionConfirmation(confirmation)) {
    return json({ error: 'confirmation_required', code: 'CONFIRMATION_MISMATCH' }, 400)
  }
  if (!isWellFormedDeletionToken(ticket)) {
    return json({ error: 'reauth_required', code: 'REAUTH_REQUIRED' }, 412)
  }

  const allow = deps.allowConfirm ?? deletionConfirmLimiter
  const clientKey = deps.clientKey ?? resetCheckClientKey
  if (!allow(clientKey(request.headers))) {
    log(DELETION_CONFIRM_LIMITED_LOG)
    return json({ error: 'too_many_attempts' }, 429)
  }

  const clientAddressOf =
    deps.clientAddressOf ?? ((headers: Headers) => clientAddress(headers) ?? null)

  let stored: StoredTicket | null = null
  try {
    const consumed = await consumeDeletionVerification(database, `${TICKET_PREFIX}${hashDeletionToken(ticket)}`, now())
    if (consumed && consumed.type === 'deletion-ticket') stored = consumed as unknown as StoredTicket
  } catch (error) {
    log(`[hitly account-deletion] Could not consume the re-auth ticket: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'deletion_failed' }, 500)
  }
  // A spent, expired, malformed or foreign ticket is worth nothing.
  if (!stored || stored.userId !== user.id) {
    return json({ error: 'reauth_required', code: 'REAUTH_REQUIRED' }, 412)
  }

  let hmacKey: string
  try {
    hmacKey = resolveSecurityEventHmacKey(process.env)
  } catch {
    // Without a stable HMAC key the ruling "keep the events, anonymised"
    // cannot be honoured, so refuse rather than store a plain id/email.
    log('[hitly account-deletion] No security-event HMAC key configured')
    return json({ error: 'deletion_failed' }, 500)
  }

  try {
    const accountRows = await database
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    const account = accountRows[0]
    if (!account) {
      // Already deleted: the same answer, and nothing left to destroy.
      return json({ ok: true, alreadyDeleted: true })
    }
    const email = account.email

    const inputs = await collectWorkspaceInputs(database, user.id)
    const plan: AccountDeletionPlan = planAccountDeletion(inputs)
    if (plan.hasBlocker) {
      const reason = plan.blockedWorkspaces[0]!.reason
      return json(
        {
          error: 'deletion_blocked',
          code: reason === 'active_subscription' ? 'ACTIVE_SUBSCRIPTION' : 'SOLE_OWNER_OF_SHARED_WORKSPACE',
          message: blockedWorkspaceMessage(reason),
          blockedWorkspaces: plan.blockedWorkspaces,
        },
        409,
      )
    }

    const recipients = await apiKeyReviewRecipients(database, plan.keptWorkspaces.map((w) => w.id), user.id)
    const deletableIds = plan.deletableWorkspaces.map((workspace) => workspace.id)
    const keptIds = plan.keptWorkspaces.map((workspace) => workspace.id)
    const truncatedIp = truncateIpAddress(clientAddressOf(request.headers))
    const userIdHmac = securityEventHmac(hmacKey, user.id)
    const emailHmac = securityEventHmac(hmacKey, email)
    const retentionExpiresAt = securityEventRetentionExpiresAt(securityEventRetentionDays(process.env), now())

    await database.transaction(async (tx) => {
      // 1. Surviving decision records lose the reviewer's identity and device.
      await anonymiseDecisionRecords(tx, user.id, keptIds)

      // 2. Security events outlive the account, anonymised, for the retention
      //    window. They must be rewritten while the user row still exists.
      await tx
        .update(accountSecurityEvents)
        .set({
          userId: null,
          userIdHmac,
          emailHmac,
          ipTruncated: truncatedIp,
          retentionExpiresAt,
        })
        .where(eq(accountSecurityEvents.userId, user.id))
      // The deletion itself is recorded as an already-anonymised event, so the
      // audit trail proves WHEN the account went away without keeping a PII
      // reference to it.
      await tx.insert(accountSecurityEvents).values({
        id: rowId('sec'),
        userId: null,
        type: ACCOUNT_DELETION_SECURITY_EVENT,
        userIdHmac,
        emailHmac,
        ipTruncated: truncatedIp,
        retentionExpiresAt,
        createdAt: new Date(now()),
      })

      // 3. Pending email-change / verification tokens, and any pending invite
      //    addressed to this address.
      await tx.delete(pendingEmailChanges).where(eq(pendingEmailChanges.userId, user.id))
      await tx.delete(pendingEmailVerifications).where(eq(pendingEmailVerifications.userId, user.id))
      await tx.delete(invites).where(eq(invites.email, email))

      // 4. Sole-member workspaces and everything inside them.
      for (const workspaceId of deletableIds) {
        if (edition.applyTenantContext) await edition.applyTenantContext(tx, workspaceId)
        await deleteWorkspaceContents(tx, workspaceId)
      }
      // Anything left in a surviving workspace is the membership row, which the
      // user cascade also removes; delete it explicitly so the tenant context
      // covers it in the Cloud edition.
      for (const workspaceId of keptIds) {
        if (edition.applyTenantContext) await edition.applyTenantContext(tx, workspaceId)
        await tx.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)))
      }

      // 5. The account. Cascades take sessions, accounts, MFA, passkeys,
      //    devices, push tokens and any remaining membership rows.
      await tx.delete(users).where(eq(users.id, user.id))
    })

    log(`${ACCOUNT_DELETED_LOG} user=${user.id}`)

    const notifyDeleted =
      deps.notifyDeleted ?? createSendAccountDeletedEmail(deps.sendMail ?? sendMail)
    const notifyApiKeyReview =
      deps.notifyApiKeyReview ?? createSendApiKeyReviewNotice(deps.sendMail ?? sendMail)

    void notifyDeleted({ to: email }).catch(() => {
      log('[hitly account-deletion] Could not queue the deletion confirmation email')
    })
    for (const recipient of recipients) {
      void notifyApiKeyReview({ to: recipient.email, workspaceName: recipient.workspaceName }).catch(() => {
        log('[hitly account-deletion] Could not queue an API-key review notice')
      })
    }

    const response = json({ ok: true, alreadyDeleted: false })
    // The session no longer exists; make the browser forget the cookie too.
    for (const name of ['better-auth.session_token', '__Secure-better-auth.session_token']) {
      response.headers.append('set-cookie', `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`)
    }
    expireChallengeCookie(response)
    return response
  } catch (error) {
    log(`[hitly account-deletion] Could not delete the account: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'deletion_failed' }, 500)
  }
}

/** Rows the housekeeping sweep may delete: anonymised and past retention only. */
export function isPurgeableSecurityEvent(row: {
  userId: string | null
  retentionExpiresAt: Date | null
  now: number
}): boolean {
  return row.userId === null && row.retentionExpiresAt !== null && row.retentionExpiresAt.getTime() < row.now
}
