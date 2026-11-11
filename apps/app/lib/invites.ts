import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { invites, memberships, users, workspaces } from '@hitly/db/schema'
import { renderInviteEmail, sendMail } from '@hitly/mail'
import { db } from './db'
import { newId } from './ids'
import { APIError } from 'better-auth/api'
import { currentInviteSignup, normaliseEmail, runWithInviteSignup, type InviteSignupContext } from './invite-signup'

/** How long an invite link stays valid. */
export const INVITE_TTL_DAYS = 14
export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000

/** The accept page: /invite/<token>. */
export const INVITE_PAGE = '/invite'

export const SIGNUP_DISABLED_MESSAGE = 'Account creation is currently disabled. Contact us for early access.'

export const INVITE_MESSAGES = {
  invalid: 'This invite link is not valid or has been revoked. Ask the workspace admin to send a new invite.',
  expired: 'This invite has expired. Ask the workspace admin to send a new invite.',
  used: 'This invite has already been used. Sign in to open the workspace, or ask the admin for a new invite.',
  wrongEmail: 'This invite was sent to a different email address. Sign out, then open the link again and use the invited email.',
  accountExists: 'An account already exists for this email. Sign in to accept the invite.',
} as const

export type InviteRefusal = 'invalid' | 'expired' | 'used' | 'wrong_email' | 'account_exists'

type InviteRow = typeof invites.$inferSelect
type Database = NonNullable<typeof db>
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

function requireDatabase(): Database {
  if (!db) throw new Error('DATABASE_URL is not set')
  return db
}

/** 256 bits from the OS CSPRNG, base64url (43 characters). */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** Rejects anything that is not a token we could have issued, before touching the database. */
export function isWellFormedInviteToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token)
}

/** Accept link on the configured public app URL (BETTER_AUTH_URL). */
export function buildInviteUrl(appUrl: string, token: string): string {
  return new URL(`${INVITE_PAGE}/${encodeURIComponent(token)}`, appUrl).toString()
}

export async function buildInviteEmail(args: { to: string; workspaceName: string; link: string }) {
  const rendered = await renderInviteEmail({
    appUrl: new URL(args.link).origin,
    workspaceName: args.workspaceName,
    link: args.link,
    inviteeEmail: args.to,
    ttlDays: INVITE_TTL_DAYS,
  })
  return { to: args.to, ...rendered }
}

/**
 * Creates a pending invite and emails the accept link. Any earlier pending
 * invite for the same workspace and email is replaced, so inviting again
 * resends a fresh link and the old one stops working. Only the token hash is
 * stored; the token exists in memory just long enough to build the email.
 */
export async function createAndSendWorkspaceInvite(args: {
  workspaceId: string
  workspaceName: string
  email: string
  role: 'admin' | 'member'
  invitedByUserId: string | null
  appUrl: string
  database?: Database | Tx
  send?: typeof sendMail
}) {
  const database = args.database ?? requireDatabase()
  const email = normaliseEmail(args.email)
  const token = generateInviteToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  await database
    .delete(invites)
    .where(and(eq(invites.workspaceId, args.workspaceId), eq(invites.email, email), isNull(invites.acceptedAt)))
  const id = newId('inv').slice(0, 36)
  await database.insert(invites).values({
    id,
    workspaceId: args.workspaceId,
    email,
    role: args.role,
    invitedByUserId: args.invitedByUserId,
    tokenHash: hashInviteToken(token),
    expiresAt,
  })
  const send = args.send ?? sendMail
  await send(await buildInviteEmail({ to: email, workspaceName: args.workspaceName, link: buildInviteUrl(args.appUrl, token) }))
  return { id, expiresAt }
}

/**
 * Issues a fresh token for a pending invite (including invites created before
 * tokens existed), resets the expiry, and emails the new link. The old token
 * stops working at once because its hash is overwritten.
 */
export async function resendWorkspaceInvite(args: {
  workspaceId: string
  workspaceName: string
  inviteId: string
  appUrl: string
  database?: Database | Tx
  send?: typeof sendMail
}): Promise<{ ok: true; expiresAt: Date } | { ok: false }> {
  const database = args.database ?? requireDatabase()
  const token = generateInviteToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const rows = await database
    .update(invites)
    .set({ tokenHash: hashInviteToken(token), expiresAt })
    .where(and(eq(invites.id, args.inviteId), eq(invites.workspaceId, args.workspaceId), isNull(invites.acceptedAt)))
    .returning({ email: invites.email })
  const row = rows[0]
  if (!row) return { ok: false }
  const send = args.send ?? sendMail
  await send(await buildInviteEmail({ to: row.email, workspaceName: args.workspaceName, link: buildInviteUrl(args.appUrl, token) }))
  return { ok: true, expiresAt }
}

/** Deletes a pending invite; its token stops working (reported as not valid / revoked). */
export async function revokeWorkspaceInvite(args: { workspaceId: string; inviteId: string; database?: Database | Tx }) {
  const database = args.database ?? requireDatabase()
  const rows = await database
    .delete(invites)
    .where(and(eq(invites.id, args.inviteId), eq(invites.workspaceId, args.workspaceId)))
    .returning({ id: invites.id })
  return rows.length > 0
}

export type InviteLookup =
  | { ok: true; invite: InviteRow; workspaceName: string }
  | { ok: false; reason: Exclude<InviteRefusal, 'wrong_email' | 'account_exists'> }

/** Read-only check of a token: never consumes it. */
export async function lookupInvite(token: unknown, database: Database | Tx = requireDatabase()): Promise<InviteLookup> {
  if (!isWellFormedInviteToken(token)) return { ok: false, reason: 'invalid' }
  const rows = await database
    .select({ invite: invites, workspaceName: workspaces.name })
    .from(invites)
    .innerJoin(workspaces, eq(invites.workspaceId, workspaces.id))
    .where(eq(invites.tokenHash, hashInviteToken(token)))
    .limit(1)
  const row = rows[0]
  if (!row || !row.invite.tokenHash) return { ok: false, reason: 'invalid' }
  // Defence in depth: the unique index already matched the hash.
  const a = Buffer.from(row.invite.tokenHash, 'hex')
  const b = Buffer.from(hashInviteToken(token), 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'invalid' }
  if (row.invite.acceptedAt) return { ok: false, reason: 'used' }
  if (row.invite.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' }
  return { ok: true, invite: row.invite, workspaceName: row.workspaceName }
}

export function emailsMatch(a: string, b: string) {
  return normaliseEmail(a) === normaliseEmail(b)
}

/**
 * Atomically marks the invite used, only if it is still unused, unexpired and
 * addressed to `email` (case-insensitive). Exactly one concurrent caller can
 * win; everyone else gets null.
 */
export async function claimInvite(database: Database | Tx, token: string, email: string): Promise<InviteRow | null> {
  const rows = await database
    .update(invites)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(invites.tokenHash, hashInviteToken(token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, sql`now()`),
        sql`lower(${invites.email}) = ${normaliseEmail(email)}`,
      ),
    )
    .returning()
  return rows[0] ?? null
}

/** Puts back an invite claimed by `claimInvite` when the rest of the accept failed. */
export async function releaseInvite(database: Database | Tx, invite: InviteRow) {
  if (!invite.acceptedAt) return
  await database
    .update(invites)
    .set({ acceptedAt: null })
    .where(and(eq(invites.id, invite.id), eq(invites.acceptedAt, invite.acceptedAt)))
}

async function addMembership(database: Database | Tx, invite: InviteRow, userId: string) {
  await database
    .insert(memberships)
    .values({
      id: newId('mem').slice(0, 36),
      workspaceId: invite.workspaceId,
      userId,
      role: invite.role === 'admin' ? 'admin' : 'member',
    })
    .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] })
}

/** Why a token could not be claimed, worked out after a failed claim. */
async function refusalAfterFailedClaim(database: Database | Tx, token: string, email: string): Promise<InviteRefusal> {
  const lookup = await lookupInvite(token, database)
  if (!lookup.ok) return lookup.reason
  if (!emailsMatch(lookup.invite.email, email)) return 'wrong_email'
  return 'used'
}

export type AcceptResult = { ok: true; workspaceId: string } | { ok: false; reason: InviteRefusal }

/**
 * A signed-in user accepts an invite. Their account email must match the
 * invite. The claim and the membership insert commit together.
 */
export async function acceptInviteAsUser(
  token: unknown,
  user: { id: string; email: string },
  database: Database = requireDatabase(),
): Promise<AcceptResult> {
  if (!isWellFormedInviteToken(token)) return { ok: false, reason: 'invalid' }
  return database.transaction(async (tx) => {
    const claimed = await claimInvite(tx, token, user.email)
    if (!claimed) return { ok: false as const, reason: await refusalAfterFailedClaim(tx, token, user.email) }
    await addMembership(tx, claimed, user.id)
    return { ok: true as const, workspaceId: claimed.workspaceId }
  })
}

/**
 * The Better Auth user-create gate (lib/auth.ts databaseHooks.user.create.before).
 *
 * - No invite token in play: allowed only when public signup is on.
 * - Invite token in play (set by the invite accept route): the token is
 *   validated here, server-side, and consumed atomically for exactly the
 *   email being created. Wrong email, expired, used and unknown/revoked
 *   tokens are refused, whatever the signup setting.
 */
export async function gateAccountCreation(email: string, signupEnabled: boolean) {
  const context = currentInviteSignup()
  if (!context) {
    if (signupEnabled) return
    throw new APIError('FORBIDDEN', { message: SIGNUP_DISABLED_MESSAGE })
  }
  const database = requireDatabase()
  const claimed = await claimInvite(database, context.token, email)
  if (!claimed) {
    const reason = await refusalAfterFailedClaim(database, context.token, email)
    context.refusal = reason
    throw new APIError('FORBIDDEN', { message: refusalMessage(reason) })
  }
  context.claimed = claimed
}

/**
 * Creates an account for the invited email (even with public signup off) and
 * joins the workspace. `createAccount` runs Better Auth's sign-up; its
 * user-create hook (gateAccountCreation) validates and consumes the token. If
 * account creation fails after the token was consumed, the invite is put back
 * so the same link can be retried.
 */
export async function acceptInviteWithNewAccount<T>(
  token: unknown,
  createAccount: (email: string) => Promise<{ userId: string; result: T }>,
  database: Database = requireDatabase(),
): Promise<{ ok: true; workspaceId: string; result: T } | { ok: false; reason: InviteRefusal }> {
  const lookup = await lookupInvite(token, database)
  if (!lookup.ok) return { ok: false, reason: lookup.reason }
  const email = normaliseEmail(lookup.invite.email)
  const existing = await database.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing.length > 0) return { ok: false, reason: 'account_exists' }

  const context: InviteSignupContext = { token: token as string, claimed: null, refusal: null }
  let created: { userId: string; result: T }
  try {
    created = await runWithInviteSignup(context, () => createAccount(email))
  } catch (error) {
    if (context.refusal) return { ok: false, reason: context.refusal as InviteRefusal }
    if (context.claimed) await releaseInvite(database, context.claimed as InviteRow)
    throw error
  }
  const claimed = context.claimed as InviteRow | null
  if (!claimed) throw new Error('Invite was not consumed by the account-create hook')
  await database.transaction(async (tx) => {
    await addMembership(tx, claimed, created.userId)
    // The token arrived by email to this address, which proves ownership.
    await tx.update(users).set({ emailVerified: true }).where(eq(users.id, created.userId))
  })
  return { ok: true, workspaceId: claimed.workspaceId, result: created.result }
}

export function refusalMessage(reason: InviteRefusal): string {
  switch (reason) {
    case 'expired':
      return INVITE_MESSAGES.expired
    case 'used':
      return INVITE_MESSAGES.used
    case 'wrong_email':
      return INVITE_MESSAGES.wrongEmail
    case 'account_exists':
      return INVITE_MESSAGES.accountExists
    default:
      return INVITE_MESSAGES.invalid
  }
}

export function refusalStatus(reason: InviteRefusal): number {
  switch (reason) {
    case 'expired':
    case 'used':
      return 410
    case 'wrong_email':
      return 403
    case 'account_exists':
      return 409
    default:
      return 404
  }
}
