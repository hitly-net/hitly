/**
 * Server half of public sign-up email verification: confirm (POST) and
 * signed-in resend. Issuing the token lives in lib/email-verification-issue.ts
 * so the auth user-create hook does not import this module (it imports auth).
 *
 * Confirm is POST-only. GET/HEAD must not be wired to this handler. On
 * success the flag is set and an `email_verified` account-security event is
 * recorded in the same transaction that deletes the pending row.
 *
 * Resend answers { ok: true } whether or not the account still needs a mail,
 * so the body does not reveal verification state. A missing session is 401
 * because the route is signed-in only and takes no email address.
 *
 * Nothing here logs a token or an address.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { accountSecurityEvents, pendingEmailVerifications, users } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { EMAIL_VERIFIED_EVENT } from './email-verification'
import {
  hashEmailVerificationToken,
  isWellFormedEmailVerificationToken,
  issueEmailVerification,
  type IssueEmailVerificationDeps,
} from './email-verification-issue'
import {
  RESEND_EMAIL_VERIFICATION_LIMITED_LOG,
  RESEND_EMAIL_VERIFICATION_WINDOW_MS,
  resendEmailVerificationAttemptAcquire,
} from './email-verification-limit'
import { resolveDecision, withRetryAfter, type RateAcquire } from './rate-limit'
import { newId } from './ids'
import { resetCheckClientKey } from './reset-check-limit'

type Database = NonNullable<typeof db>
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export type EmailVerificationSessionUser = { id: string }

export interface EmailVerificationRouteDeps extends IssueEmailVerificationDeps {
  getSessionUser?: (headers: Headers) => Promise<EmailVerificationSessionUser | null>
  clientKey?: (headers: Headers) => string
  allow?: RateAcquire
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

async function defaultGetSessionUser(headers: Headers): Promise<EmailVerificationSessionUser | null> {
  if (!auth) return null
  const session = await auth.api.getSession({ headers })
  return session?.user ? { id: session.user.id } : null
}

async function writeVerifiedEvent(tx: Tx, userId: string) {
  await tx.insert(accountSecurityEvents).values({
    id: newId('ase').slice(0, 36),
    userId,
    type: EMAIL_VERIFIED_EVENT,
  })
}

type TokenRequest = { headers: Headers; json: () => Promise<unknown> }

/**
 * Confirms a sign-up verification token. Expired, used, unknown and malformed
 * tokens all answer the same invalid_token error, and none of them set the
 * flag. Call this only from POST.
 */
export async function handleEmailVerificationConfirm(
  token: unknown,
  deps: EmailVerificationRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now

  if (!isWellFormedEmailVerificationToken(token)) {
    return json({ error: 'invalid_token' }, 400)
  }

  let database: Database
  try {
    database = requireDatabase(deps.database)
  } catch {
    log('[hitly email-verification] Database is not configured')
    return json({ error: 'verify_email_failed' }, 500)
  }

  const tokenHash = hashEmailVerificationToken(token)
  try {
    await database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(pendingEmailVerifications)
        .where(eq(pendingEmailVerifications.tokenHash, tokenHash))
        .for('update')
        .limit(1)
      const pending = rows[0]
      if (!pending) throw new InvalidTokenError()
      if (pending.expiresAt.getTime() <= now()) throw new InvalidTokenError()

      const current = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, pending.userId))
        .limit(1)
      if (!current[0]) throw new InvalidTokenError()
      // The token only proves control of the address it was sent to.
      if (current[0].email !== pending.email) throw new InvalidTokenError()

      await tx
        .update(users)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, pending.userId))
      await tx.delete(pendingEmailVerifications).where(eq(pendingEmailVerifications.id, pending.id))
      await writeVerifiedEvent(tx, pending.userId)
    })
  } catch (error) {
    if (error instanceof InvalidTokenError) return json({ error: 'invalid_token' }, 400)
    log(`[hitly email-verification] Could not confirm the email: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'verify_email_failed' }, 500)
  }

  return json({ ok: true })
}

/**
 * Signed-in resend. Over the per-client limit: 429, and no mail. Otherwise
 * { ok: true } whether the account is already verified (nothing stored or
 * sent) or still unverified (a new token replaces the previous one).
 */
export async function handleResendEmailVerification(
  request: TokenRequest,
  deps: EmailVerificationRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const getSessionUser = deps.getSessionUser ?? defaultGetSessionUser
  const allow = deps.allow ?? resendEmailVerificationAttemptAcquire
  const clientKey = deps.clientKey ?? resetCheckClientKey

  let session: EmailVerificationSessionUser | null
  try {
    session = await getSessionUser(request.headers)
  } catch (error) {
    log(`[hitly email-verification] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'resend_failed' }, 500)
  }
  if (!session) return json({ error: 'unauthorized' }, 401)

  const budget = await resolveDecision(allow, clientKey(request.headers), RESEND_EMAIL_VERIFICATION_WINDOW_MS)
  if (!budget.allowed) {
    log(RESEND_EMAIL_VERIFICATION_LIMITED_LOG)
    return withRetryAfter(json({ error: 'too_many_attempts' }, 429), budget.retryAfterMs)
  }

  let database: Database
  try {
    database = requireDatabase(deps.database)
  } catch {
    log('[hitly email-verification] Database is not configured')
    return json({ error: 'resend_failed' }, 500)
  }

  try {
    const rows = await database
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, session.id))
      .limit(1)
    const user = rows[0]
    // Already verified, or the account row is gone: same body, no mail.
    if (!user || user.emailVerified) return json({ ok: true })
    await issueEmailVerification({ userId: user.id, email: user.email }, { ...deps, database })
  } catch (error) {
    log(`[hitly email-verification] Could not resend verification: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'resend_failed' }, 500)
  }

  return json({ ok: true })
}
