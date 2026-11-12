/**
 * Stores a public sign-up verification token and queues the mail.
 *
 * Better Auth 1.6.27 emailVerification is a stateless JWT confirmed by
 * GET /api/auth/verify-email. That token is not written to `verifications`,
 * is not single-use, and the GET mutates. This module mirrors the email-change
 * confirm flow instead: 32-byte token, SHA-256 hex at rest, 24h expiry, a new
 * issue replaces any earlier row for the same user.
 *
 * Nothing here logs the token or the address.
 */

import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { pendingEmailVerifications } from '@hitly/db/schema'
import { db } from './db'
import { EMAIL_VERIFICATION_TTL_MS } from './email-verification'
import { createSendEmailVerification } from './email-verification-emails'
import { newId } from './ids'
import { sendMail } from './mail'

type Database = NonNullable<typeof db>

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

const inflight = new Set<Promise<unknown>>()

export function trackEmailVerificationMail(chain: Promise<unknown>) {
  inflight.add(chain)
  void chain.finally(() => inflight.delete(chain))
}

/** Waits until every verification mail started in this process has settled. */
export async function drainEmailVerificationMail() {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight])
  }
}

/** 256 bits from the OS CSPRNG, base64url (43 characters). */
export function generateEmailVerificationToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashEmailVerificationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function isWellFormedEmailVerificationToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE.test(token)
}

export interface IssueEmailVerificationDeps {
  database?: Database
  now?: () => number
  send?: (args: { to: string; token: string }) => Promise<void>
}

/**
 * Replaces any pending verification for this user with a new hashed token
 * and queues the mail. The caller decides when a public sign-up (and not an
 * invite accept) should issue one. Does not change `email_verified`.
 */
export async function issueEmailVerification(
  args: { userId: string; email: string },
  deps: IssueEmailVerificationDeps = {},
): Promise<void> {
  const database = deps.database ?? db
  if (!database) throw new Error('DATABASE_URL is not set')
  const now = deps.now ?? Date.now
  const send =
    deps.send ?? createSendEmailVerification(APP_URL, sendMail, { track: trackEmailVerificationMail })

  const token = generateEmailVerificationToken()
  const expiresAt = new Date(now() + EMAIL_VERIFICATION_TTL_MS)
  await database.transaction(async (tx) => {
    await tx.delete(pendingEmailVerifications).where(eq(pendingEmailVerifications.userId, args.userId))
    await tx.insert(pendingEmailVerifications).values({
      id: newId('emv').slice(0, 36),
      userId: args.userId,
      tokenHash: hashEmailVerificationToken(token),
      expiresAt,
    })
  })
  void send({ to: args.email, token }).catch(() => {
    console.warn('[hitly email-verification] Could not queue the verification email')
  })
}
