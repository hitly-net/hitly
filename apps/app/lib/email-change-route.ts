/**
 * The server half of the signed-in email change: the handlers behind
 * POST /api/session/change-email and POST /api/session/verify-email-change
 * (lib/email-change.ts holds the client-safe helpers the forms import).
 * Server-only imports (auth, the database, the mailer) stay out of the
 * client bundle by living here.
 *
 * The live users.email column is not updated until the confirmation token
 * is presented. Pending state lives in pending_email_changes (token stored
 * only as a SHA-256 hash). A new request replaces any earlier pending row
 * for the same user.
 *
 * Nothing here logs a password or a token: failures are logged as fixed
 * lines only.
 */

import { createHash, randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, eq, ne, sql } from 'drizzle-orm'
import { isAPIError } from 'better-auth/api'
import { pendingEmailChanges, pendingEmailVerifications, users } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { EMAIL_CHANGE_ATTEMPT_WINDOW_MS, EMAIL_CHANGE_LIMITED_LOG, emailChangeAttemptAcquire } from './email-change-limit'
import { resolveDecision, withRetryAfter, type RateAcquire } from './rate-limit'
import {
  EMAIL_CHANGE_TTL_MS,
} from './email-change'
import {
  createSendEmailChangeVerification,
  createSendEmailChangedNotice,
} from './email-change-emails'
import { newId } from './ids'
import { normaliseEmail } from './invite-signup'
import { sendMail } from './mail'
import { resetCheckClientKey } from './reset-check-limit'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/
const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

type Database = NonNullable<typeof db>
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export type EmailChangeSessionUser = { id: string; email: string }

export interface EmailChangeRouteDeps {
  getSessionUser?: (headers: Headers) => Promise<EmailChangeSessionUser | null>
  /** Reuses Better Auth's in-process verifyPassword helper. */
  verifyPassword?: (headers: Headers, password: string) => Promise<boolean>
  clientKey?: (headers: Headers) => string
  allow?: RateAcquire
  now?: () => number
  database?: Database
  sendVerification?: (args: { to: string; token: string }) => Promise<void>
  sendChangedNotice?: (args: { to: string }) => Promise<void>
  log?: (line: string) => void
}

class InvalidTokenError extends Error {
  constructor() {
    super('invalid_token')
    this.name = 'InvalidTokenError'
  }
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

/** 256 bits from the OS CSPRNG, base64url (43 characters). */
export function generateEmailChangeToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashEmailChangeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function isWellFormedEmailChangeToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token)
}

function isWellFormedEmail(value: string): boolean {
  return value.length <= 255 && EMAIL_SHAPE.test(value)
}

async function emailTakenByOther(
  database: Database | Tx,
  email: string,
  userId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, userId)))
    .limit(1)
  return rows.length > 0
}

function isUniqueViolation(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  const cause =
    error && typeof error === 'object' && 'cause' in error ? (error as { cause?: { code?: unknown } }).cause : undefined
  return code === '23505' || cause?.code === '23505'
}

type ChangeEmailRequest = { headers: Headers; json: () => Promise<unknown> }

/**
 * Handler for POST /api/session/change-email.
 *
 * 1. no session -> 401, the change is never attempted;
 * 2. the client's attempt budget must not be spent, else 429 without
 *    checking the password;
 * 3. the current password is checked through Better Auth's verifyPassword
 *    helper (a wrong one answers INVALID_PASSWORD and stores nothing);
 * 4. a well-formed new address always answers { ok: true }. If it is free,
 *    a pending row is stored (hash only) and a confirmation is emailed to
 *    the new address. If it is already taken the reply is the same and
 *    nothing is stored or sent (no account enumeration).
 */
export async function handleEmailChange(
  request: ChangeEmailRequest,
  deps: EmailChangeRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const authInstance = auth
  const getSessionUser =
    deps.getSessionUser ??
    (async (headers: Headers) => {
      if (!authInstance) return null
      const session = await authInstance.api.getSession({ headers })
      return session?.user ? { id: session.user.id, email: session.user.email } : null
    })
  const verifyPassword =
    deps.verifyPassword ??
    (async (headers: Headers, password: string) => {
      if (!authInstance) throw new Error('auth unavailable')
      try {
        const result = (await authInstance.api.verifyPassword({
          headers,
          body: { password },
          asResponse: true,
        })) as unknown as Response
        return result.status === 200
      } catch (error) {
        if (isAPIError(error)) return false
        throw error
      }
    })
  const allow = deps.allow ?? emailChangeAttemptAcquire
  const clientKey = deps.clientKey ?? resetCheckClientKey
  const now = deps.now ?? Date.now
  const sendVerification =
    deps.sendVerification ?? createSendEmailChangeVerification(APP_URL, sendMail)

  let user: EmailChangeSessionUser | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    log(`[hitly email-change] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'change_email_failed' }, 500)
  }
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newEmail = typeof body.newEmail === 'string' ? body.newEmail : ''
  if (!currentPassword || !newEmail) {
    return json({ code: 'MISSING_FIELDS' }, 400)
  }
  if (!isWellFormedEmail(newEmail.trim())) {
    return json({ code: 'INVALID_EMAIL' }, 400)
  }

  const budget = await resolveDecision(allow, clientKey(request.headers), EMAIL_CHANGE_ATTEMPT_WINDOW_MS)
  if (!budget.allowed) {
    log(EMAIL_CHANGE_LIMITED_LOG)
    return withRetryAfter(json({ error: 'too_many_attempts' }, 429), budget.retryAfterMs)
  }

  let passwordOk: boolean
  try {
    passwordOk = await verifyPassword(request.headers, currentPassword)
  } catch {
    log('[hitly email-change] Password verification failed with an unexpected error')
    return json({ error: 'change_email_failed' }, 500)
  }
  if (!passwordOk) return json({ code: 'INVALID_PASSWORD' }, 400)

  const normalised = normaliseEmail(newEmail)
  if (normalised === normaliseEmail(user.email)) {
    return json({ ok: true })
  }

  let database: Database
  try {
    database = requireDatabase(deps.database)
  } catch {
    log('[hitly email-change] Database is not configured')
    return json({ error: 'change_email_failed' }, 500)
  }

  try {
    const taken = await emailTakenByOther(database, normalised, user.id)
    if (taken) return json({ ok: true })

    const token = generateEmailChangeToken()
    const expiresAt = new Date(now() + EMAIL_CHANGE_TTL_MS)
    await database.delete(pendingEmailChanges).where(eq(pendingEmailChanges.userId, user.id))
    await database.insert(pendingEmailChanges).values({
      id: newId('eml').slice(0, 36),
      userId: user.id,
      pendingEmail: normalised,
      tokenHash: hashEmailChangeToken(token),
      expiresAt,
    })
    void sendVerification({ to: normalised, token }).catch(() => {
      log('[hitly email-change] Could not queue the confirmation email')
    })
  } catch (error) {
    log(`[hitly email-change] Could not store the pending change: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'change_email_failed' }, 500)
  }

  return json({ ok: true })
}

/**
 * Confirms a pending email change. Expired, used, unknown, and colliding
 * tokens all answer the same invalid_token error. On success the live email
 * is switched atomically (emailVerified set true), the pending row is
 * cleared, other sessions are kept, and a notice goes to the previous
 * address. Call this only from POST — GET/HEAD must not.
 */
export async function handleEmailChangeVerify(
  token: unknown,
  deps: EmailChangeRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now
  const sendChangedNotice = deps.sendChangedNotice ?? createSendEmailChangedNotice(sendMail)

  if (!isWellFormedEmailChangeToken(token)) {
    return json({ error: 'invalid_token' }, 400)
  }

  let database: Database
  try {
    database = requireDatabase(deps.database)
  } catch {
    log('[hitly email-change] Database is not configured')
    return json({ error: 'change_email_failed' }, 500)
  }

  const tokenHash = hashEmailChangeToken(token)
  let oldEmail: string | null = null
  try {
    oldEmail = await database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(pendingEmailChanges)
        .where(eq(pendingEmailChanges.tokenHash, tokenHash))
        .for('update')
        .limit(1)
      const pending = rows[0]
      if (!pending) throw new InvalidTokenError()
      if (pending.expiresAt.getTime() <= now()) throw new InvalidTokenError()

      const taken = await emailTakenByOther(tx, pending.pendingEmail, pending.userId)
      if (taken) throw new InvalidTokenError()

      const current = await tx.select({ email: users.email }).from(users).where(eq(users.id, pending.userId)).limit(1)
      if (!current[0]) throw new InvalidTokenError()

      await tx
        .update(users)
        .set({ email: pending.pendingEmail, emailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, pending.userId))
      await tx.delete(pendingEmailChanges).where(eq(pendingEmailChanges.id, pending.id))
      // The sign-up token was mailed to the previous address.
      await tx.delete(pendingEmailVerifications).where(eq(pendingEmailVerifications.userId, pending.userId))
      return current[0].email
    })
  } catch (error) {
    if (error instanceof InvalidTokenError || isUniqueViolation(error)) {
      return json({ error: 'invalid_token' }, 400)
    }
    log(`[hitly email-change] Could not confirm the email change: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'change_email_failed' }, 500)
  }

  if (oldEmail) {
    void sendChangedNotice({ to: oldEmail }).catch(() => {
      log('[hitly email-change] Could not queue the email-changed notice')
    })
  }
  return json({ ok: true })
}
