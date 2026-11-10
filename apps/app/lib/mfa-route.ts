/**
 * The server half of account MFA: handlers behind POST /api/session/mfa/*
 * (lib/mfa.ts holds the client-safe helpers the forms import). Server-only
 * imports (auth, the database, the wrapping key) stay out of the client
 * bundle by living here.
 *
 * Re-auth for enrol, disable, and recovery-code regenerate uses Better Auth's
 * verifyPassword helper the same way signed-in email change does. A wrong
 * current password answers INVALID_PASSWORD and changes nothing. Disable and
 * recovery-code regenerate also require a valid current TOTP code or an unused
 * recovery code (consumed on success), using the same per-user/per-IP limiter
 * and lockout as login MFA verify.
 *
 * Successful disable, recovery-code regenerate, and confirm (other-session
 * revoke) write a value-free auth-log line (event name plus user id only).
 * Nothing here logs a password, TOTP secret, otpauth URI, recovery code, or
 * hash: failures use fixed lines.
 */

import { createHash, randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { isAPIError } from 'better-auth/api'
import {
  accountSecurityEvents,
  sessions,
  userMfa,
  userMfaChallenges,
  userMfaRecoveryCodes,
} from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { newId } from './ids'
import { MFA_CHALLENGE_COOKIE } from './mfa'
import {
  buildOtpauthUri,
  decryptUtf8,
  encryptUtf8,
  fromBase32,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  MFA_RECOVERY_CODE_COUNT,
  mfaEncryptionKeyProblem,
  MFA_ENCRYPTION_KEY_ENV,
  normaliseTotpCode,
  recoveryCodeLooksWellFormed,
  resolveMfaEncryptionKey,
  toBase32,
  verifyTotpCode,
} from './mfa-crypto'
import {
  MFA_LOCKOUT_LOG,
  MFA_LOCKOUT_MS,
  MFA_REAUTH_LIMITED_LOG,
  MFA_VERIFY_FAILURE_LIMIT,
  MFA_VERIFY_LIMITED_LOG,
  mfaReauthLimiter,
  mfaVerifyLimiter,
} from './mfa-limit'
import { renderOtpauthQr } from './mfa-qr'
import { resetCheckClientKey } from './reset-check-limit'

type Database = NonNullable<typeof db>
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export type MfaSessionUser = { id: string; email: string }

export const ACCOUNT_SECURITY_EVENT = {
  enrolled: 'mfa_enrolled',
  disabled: 'mfa_disabled',
  recoveryCodesRegenerated: 'mfa_recovery_codes_regenerated',
  recoveryCodeUsed: 'mfa_recovery_code_used',
  verificationLockout: 'mfa_verification_lockout',
  otherSessionsRevoked: 'mfa_other_sessions_revoked',
} as const

export type AccountSecurityEventType = (typeof ACCOUNT_SECURITY_EVENT)[keyof typeof ACCOUNT_SECURITY_EVENT]

/** Auth-log lines: event name plus `user=<id>` only. Never codes or secrets. */
export const MFA_DISABLED_LOG = `[hitly mfa] ${ACCOUNT_SECURITY_EVENT.disabled}`
export const MFA_RECOVERY_CODES_REGENERATED_LOG = `[hitly mfa] ${ACCOUNT_SECURITY_EVENT.recoveryCodesRegenerated}`
export const MFA_OTHER_SESSIONS_REVOKED_LOG = `[hitly mfa] ${ACCOUNT_SECURITY_EVENT.otherSessionsRevoked}`

export interface MfaRouteDeps {
  getSessionUser?: (headers: Headers) => Promise<MfaSessionUser | null>
  verifyPassword?: (headers: Headers, password: string) => Promise<boolean>
  /** Better Auth revoke-other-sessions; same helper password change uses. */
  revokeOtherSessions?: (headers: Headers) => Promise<void>
  clientKey?: (headers: Headers) => string
  allowReauth?: (key: string) => boolean
  allowVerify?: (key: string) => boolean
  now?: () => number
  database?: Database
  encryptionKey?: Buffer
  log?: (line: string) => void
}

class MfaUnavailableError extends Error {
  constructor() {
    super('mfa_unavailable')
    this.name = 'MfaUnavailableError'
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

function requireKey(explicit?: Buffer, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (explicit) return explicit
  if (mfaEncryptionKeyProblem(env[MFA_ENCRYPTION_KEY_ENV])) throw new MfaUnavailableError()
  return resolveMfaEncryptionKey(env)
}

function mfaId(prefix: string) {
  return newId(prefix).slice(0, 36)
}

export function generateMfaChallengeToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashMfaChallengeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function expireChallengeCookie(response: NextResponse, secure: boolean) {
  // Append rather than cookies.set so we do not drop session Set-Cookie values
  // already added with headers.append.
  const parts = [
    `${MFA_CHALLENGE_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  response.headers.append('set-cookie', parts.join('; '))
}

async function defaultGetSessionUser(headers: Headers): Promise<MfaSessionUser | null> {
  if (!auth) return null
  const session = await auth.api.getSession({ headers })
  return session?.user ? { id: session.user.id, email: session.user.email } : null
}

async function defaultRevokeOtherSessions(headers: Headers): Promise<void> {
  if (!auth) return
  await auth.api.revokeOtherSessions({ headers })
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

async function writeAudit(
  database: Database | Tx,
  userId: string,
  type: AccountSecurityEventType,
) {
  await database.insert(accountSecurityEvents).values({
    id: mfaId('ase'),
    userId,
    type,
  })
}

async function remainingRecoveryCodes(database: Database | Tx, userId: string): Promise<number> {
  const rows = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(userMfaRecoveryCodes)
    .where(and(eq(userMfaRecoveryCodes.userId, userId), isNull(userMfaRecoveryCodes.usedAt)))
  return Number(rows[0]?.n ?? 0)
}

async function replaceRecoveryCodes(
  database: Database | Tx,
  userId: string,
  master: Buffer,
): Promise<string[]> {
  const codes = generateRecoveryCodes(MFA_RECOVERY_CODE_COUNT)
  await database.delete(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, userId))
  if (codes.length) {
    await database.insert(userMfaRecoveryCodes).values(
      codes.map((code) => ({
        id: mfaId('mrc'),
        userId,
        codeHash: hashRecoveryCode(code, master),
      })),
    )
  }
  return codes
}

export async function getMfaStatus(userId: string, deps: MfaRouteDeps = {}): Promise<{
  enabled: boolean
  pending: boolean
  recoveryCodesRemaining: number
}> {
  const database = requireDatabase(deps.database)
  const rows = await database.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1)
  const row = rows[0]
  if (!row) return { enabled: false, pending: false, recoveryCodesRemaining: 0 }
  const remaining = await remainingRecoveryCodes(database, userId)
  return {
    enabled: row.enabled,
    pending: !row.enabled,
    recoveryCodesRemaining: remaining,
  }
}

export async function isMfaEnabled(userId: string, deps: MfaRouteDeps = {}): Promise<boolean> {
  const database = requireDatabase(deps.database)
  const rows = await database
    .select({ enabled: userMfa.enabled })
    .from(userMfa)
    .where(eq(userMfa.userId, userId))
    .limit(1)
  return rows[0]?.enabled === true
}

type ChangeRequest = { headers: Headers; json: () => Promise<unknown> }

async function requireReauthUser(
  request: ChangeRequest,
  deps: MfaRouteDeps,
): Promise<{ user: MfaSessionUser; database: Database; key: Buffer; body: Record<string, unknown> } | NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const getSessionUser = deps.getSessionUser ?? defaultGetSessionUser
  const verifyPassword = deps.verifyPassword ?? defaultVerifyPassword
  const allow = deps.allowReauth ?? mfaReauthLimiter
  const clientKey = deps.clientKey ?? resetCheckClientKey

  let user: MfaSessionUser | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    log(`[hitly mfa] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'mfa_failed' }, 500)
  }
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  if (!currentPassword) return json({ code: 'MISSING_FIELDS' }, 400)

  if (!allow(clientKey(request.headers))) {
    log(MFA_REAUTH_LIMITED_LOG)
    return json({ error: 'too_many_attempts' }, 429)
  }

  let passwordOk: boolean
  try {
    passwordOk = await verifyPassword(request.headers, currentPassword)
  } catch {
    log('[hitly mfa] Password verification failed with an unexpected error')
    return json({ error: 'mfa_failed' }, 500)
  }
  if (!passwordOk) return json({ code: 'INVALID_PASSWORD' }, 400)

  try {
    const database = requireDatabase(deps.database)
    const key = requireKey(deps.encryptionKey)
    return { user, database, key, body }
  } catch (error) {
    if (error instanceof MfaUnavailableError) {
      log('[hitly mfa] Encryption key is not configured')
      return json({ error: 'mfa_unavailable' }, 503)
    }
    log('[hitly mfa] Database is not configured')
    return json({ error: 'mfa_failed' }, 500)
  }
}

/**
 * POST /api/session/mfa/enrol — generate a pending TOTP secret and recovery
 * codes after a current-password check. MFA is not active until confirm.
 */
export async function handleMfaEnrol(request: ChangeRequest, deps: MfaRouteDeps = {}): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireReauthUser(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database, key } = prepared

  try {
    const existing = await database.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1)
    if (existing[0]?.enabled) return json({ error: 'already_enabled' }, 409)

    const { secret, base32 } = generateTotpSecret()
    const totpCiphertext = encryptUtf8(toBase32(secret), key)
    const otpauthUri = buildOtpauthUri(user.email, base32)
    const recoveryCodes = await database.transaction(async (tx) => {
      await tx.delete(userMfa).where(eq(userMfa.userId, user.id))
      await tx.insert(userMfa).values({
        id: mfaId('mfa'),
        userId: user.id,
        totpCiphertext,
        enabled: false,
        lastUsedStep: null,
        failedVerifyCount: 0,
        lockedUntil: null,
      })
      return replaceRecoveryCodes(tx, user.id, key)
    })

    return json({
      otpauthUri,
      qrSvg: renderOtpauthQr(otpauthUri),
      secret: base32,
      recoveryCodes,
    })
  } catch (error) {
    if (error instanceof MfaUnavailableError) return json({ error: 'mfa_unavailable' }, 503)
    log(`[hitly mfa] Could not start enrolment: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'mfa_failed' }, 500)
  }
}

/**
 * POST /api/session/mfa/confirm — activate pending MFA with a valid TOTP code.
 * On success, every other session for this user is revoked (current kept),
 * using Better Auth's revokeOtherSessions helper.
 */
export async function handleMfaConfirm(request: ChangeRequest, deps: MfaRouteDeps = {}): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const getSessionUser = deps.getSessionUser ?? defaultGetSessionUser
  const revokeOtherSessions = deps.revokeOtherSessions ?? defaultRevokeOtherSessions
  const allow = deps.allowVerify ?? mfaVerifyLimiter
  const clientKey = deps.clientKey ?? resetCheckClientKey
  const now = deps.now ?? Date.now

  let user: MfaSessionUser | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    log(`[hitly mfa] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'mfa_failed' }, 500)
  }
  if (!user) return json({ error: 'unauthorized' }, 401)

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const code = typeof body.code === 'string' ? body.code : ''
  if (!normaliseTotpCode(code)) return json({ error: 'invalid_code' }, 400)

  if (!allow(`user:${user.id}`) || !allow(clientKey(request.headers))) {
    log(MFA_VERIFY_LIMITED_LOG)
    return json({ error: 'too_many_attempts' }, 429)
  }

  let database: Database
  let key: Buffer
  try {
    database = requireDatabase(deps.database)
    key = requireKey(deps.encryptionKey)
  } catch (error) {
    if (error instanceof MfaUnavailableError) return json({ error: 'mfa_unavailable' }, 503)
    return json({ error: 'mfa_failed' }, 500)
  }

  try {
    const result = await database.transaction(async (tx) => {
      const rows = await tx.select().from(userMfa).where(eq(userMfa.userId, user.id)).for('update').limit(1)
      const row = rows[0]
      if (!row || row.enabled) return 'not_pending' as const
      const secret = fromBase32(decryptUtf8(row.totpCiphertext, key))
      const verified = verifyTotpCode(secret, code, now(), row.lastUsedStep)
      if (!verified.ok) return 'invalid' as const
      await tx
        .update(userMfa)
        .set({ enabled: true, lastUsedStep: verified.step, failedVerifyCount: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(userMfa.id, row.id))
      await writeAudit(tx, user.id, ACCOUNT_SECURITY_EVENT.enrolled)
      await writeAudit(tx, user.id, ACCOUNT_SECURITY_EVENT.otherSessionsRevoked)
      return 'ok' as const
    })
    if (result === 'not_pending') return json({ error: 'not_pending' }, 409)
    if (result === 'invalid') return json({ error: 'invalid_code' }, 400)
    try {
      await revokeOtherSessions(request.headers)
    } catch (error) {
      log(`[hitly mfa] Could not revoke other sessions: ${error instanceof Error ? error.name : 'error'}`)
      return json({ error: 'mfa_failed' }, 500)
    }
    log(`${MFA_OTHER_SESSIONS_REVOKED_LOG} user=${user.id}`)
    return json({ ok: true })
  } catch (error) {
    log(`[hitly mfa] Could not confirm MFA: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'mfa_failed' }, 500)
  }
}

/**
 * POST /api/session/mfa/disable — turn MFA off after a current-password check
 * plus a valid TOTP or unused recovery code (the recovery code is consumed).
 */
export async function handleMfaDisable(request: ChangeRequest, deps: MfaRouteDeps = {}): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireReauthUser(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database, key, body } = prepared
  const now = deps.now ?? Date.now

  try {
    const existing = await database.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1)
    if (!existing[0]) return json({ ok: true })

    const code = presentedCode(body)
    if (!code) return json({ error: 'invalid_code' }, 400)
    const limited = rateLimitVerify(user.id, request.headers, deps, log)
    if (limited) return limited

    const result = await database.transaction(async (tx) => {
      const rows = await tx.select().from(userMfa).where(eq(userMfa.userId, user.id)).for('update').limit(1)
      const row = rows[0]
      if (!row) return 'ok' as const
      const factor = await applyPresentedMfaFactor(tx, row, code, key, now(), log)
      if (factor.kind !== 'ok') return factor.kind
      const held = await tx.select().from(userMfaChallenges).where(eq(userMfaChallenges.userId, user.id))
      for (const challenge of held) {
        await tx.delete(sessions).where(eq(sessions.id, challenge.sessionId))
      }
      await tx.delete(userMfaChallenges).where(eq(userMfaChallenges.userId, user.id))
      await tx.delete(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, user.id))
      await tx.delete(userMfa).where(eq(userMfa.userId, user.id))
      await writeAudit(tx, user.id, ACCOUNT_SECURITY_EVENT.disabled)
      return 'ok' as const
    })
    if (result === 'locked') return json({ error: 'too_many_attempts' }, 429)
    if (result === 'invalid') return json({ error: 'invalid_code' }, 400)
    log(`${MFA_DISABLED_LOG} user=${user.id}`)
    return json({ ok: true })
  } catch (error) {
    log(`[hitly mfa] Could not disable MFA: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'mfa_failed' }, 500)
  }
}

/**
 * POST /api/session/mfa/recovery-codes — replace unused recovery codes after
 * a current-password check plus a valid TOTP or unused recovery code (the
 * presented recovery code is consumed). Plaintext of the new set is returned
 * once.
 */
export async function handleMfaRecoveryCodes(request: ChangeRequest, deps: MfaRouteDeps = {}): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireReauthUser(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database, key, body } = prepared
  const now = deps.now ?? Date.now

  try {
    const existing = await database.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1)
    if (!existing[0]?.enabled) return json({ error: 'not_enabled' }, 409)

    const code = presentedCode(body)
    if (!code) return json({ error: 'invalid_code' }, 400)
    const limited = rateLimitVerify(user.id, request.headers, deps, log)
    if (limited) return limited

    const result = await database.transaction(async (tx) => {
      const rows = await tx.select().from(userMfa).where(eq(userMfa.userId, user.id)).for('update').limit(1)
      const row = rows[0]
      if (!row?.enabled) return 'not_enabled' as const
      const factor = await applyPresentedMfaFactor(tx, row, code, key, now(), log)
      if (factor.kind !== 'ok') return factor.kind
      const codes = await replaceRecoveryCodes(tx, user.id, key)
      await writeAudit(tx, user.id, ACCOUNT_SECURITY_EVENT.recoveryCodesRegenerated)
      return { kind: 'ok' as const, codes }
    })
    if (result === 'not_enabled') return json({ error: 'not_enabled' }, 409)
    if (result === 'locked') return json({ error: 'too_many_attempts' }, 429)
    if (result === 'invalid') return json({ error: 'invalid_code' }, 400)
    log(`${MFA_RECOVERY_CODES_REGENERATED_LOG} user=${user.id}`)
    return json({ recoveryCodes: result.codes })
  } catch (error) {
    log(`[hitly mfa] Could not regenerate recovery codes: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'mfa_failed' }, 500)
  }
}

function presentedCode(body: Record<string, unknown>): string {
  return typeof body.code === 'string' ? body.code : ''
}

function rateLimitVerify(
  userId: string,
  headers: Headers,
  deps: MfaRouteDeps,
  log: (line: string) => void,
): NextResponse | null {
  const allow = deps.allowVerify ?? mfaVerifyLimiter
  const clientKey = deps.clientKey ?? resetCheckClientKey
  if (!allow(`user:${userId}`) || !allow(clientKey(headers))) {
    log(MFA_VERIFY_LIMITED_LOG)
    return json({ error: 'too_many_attempts' }, 429)
  }
  return null
}

async function recordVerifyFailure(
  database: Database | Tx,
  row: typeof userMfa.$inferSelect,
  nowMs: number,
  log: (line: string) => void,
) {
  const failed = row.failedVerifyCount + 1
  const locked = failed >= MFA_VERIFY_FAILURE_LIMIT
  await database
    .update(userMfa)
    .set({
      failedVerifyCount: failed,
      lockedUntil: locked ? new Date(nowMs + MFA_LOCKOUT_MS) : row.lockedUntil,
      updatedAt: new Date(),
    })
    .where(eq(userMfa.id, row.id))
  if (locked) {
    log(MFA_LOCKOUT_LOG)
    await writeAudit(database, row.userId, ACCOUNT_SECURITY_EVENT.verificationLockout)
  }
}

/**
 * Shared TOTP / recovery-code check used by login verify, disable, and
 * recovery-code regenerate. Applies per-user lockout and consumes a matching
 * unused recovery code. Caller must already have passed the verify limiter.
 */
async function applyPresentedMfaFactor(
  tx: Tx,
  row: typeof userMfa.$inferSelect,
  code: string,
  key: Buffer,
  nowMs: number,
  log: (line: string) => void,
): Promise<{ kind: 'ok'; usedRecovery: boolean } | { kind: 'invalid' } | { kind: 'locked' }> {
  const lockedUntil = row.lockedUntil?.getTime() ?? 0
  if (lockedUntil > nowMs) return { kind: 'locked' }
  if (lockedUntil && lockedUntil <= nowMs && row.failedVerifyCount) {
    await tx
      .update(userMfa)
      .set({ failedVerifyCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(userMfa.id, row.id))
    row.failedVerifyCount = 0
    row.lockedUntil = null
  }

  const totpDigits = normaliseTotpCode(code)
  if (totpDigits) {
    const secret = fromBase32(decryptUtf8(row.totpCiphertext, key))
    const verified = verifyTotpCode(secret, totpDigits, nowMs, row.lastUsedStep)
    if (!verified.ok) {
      await recordVerifyFailure(tx, row, nowMs, log)
      return { kind: 'invalid' }
    }
    await tx
      .update(userMfa)
      .set({ lastUsedStep: verified.step, failedVerifyCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(userMfa.id, row.id))
    return { kind: 'ok', usedRecovery: false }
  }

  if (!recoveryCodeLooksWellFormed(code)) {
    await recordVerifyFailure(tx, row, nowMs, log)
    return { kind: 'invalid' }
  }

  const codeHash = hashRecoveryCode(code, key)
  const matches = await tx
    .select()
    .from(userMfaRecoveryCodes)
    .where(
      and(
        eq(userMfaRecoveryCodes.userId, row.userId),
        eq(userMfaRecoveryCodes.codeHash, codeHash),
        isNull(userMfaRecoveryCodes.usedAt),
      ),
    )
    .for('update')
    .limit(1)
  const match = matches[0]
  if (!match) {
    await recordVerifyFailure(tx, row, nowMs, log)
    return { kind: 'invalid' }
  }
  await tx.update(userMfaRecoveryCodes).set({ usedAt: new Date() }).where(eq(userMfaRecoveryCodes.id, match.id))
  await tx
    .update(userMfa)
    .set({ failedVerifyCount: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(userMfa.id, row.id))
  await writeAudit(tx, row.userId, ACCOUNT_SECURITY_EVENT.recoveryCodeUsed)
  return { kind: 'ok', usedRecovery: true }
}

/**
 * POST /api/session/mfa/verify — second login step. Requires the
 * half-auth challenge cookie, not a full session.
 */
export async function handleMfaVerify(request: ChangeRequest, deps: MfaRouteDeps = {}): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now
  const secure = process.env.NODE_ENV === 'production'

  const token = readCookie(request.headers.get('cookie'), MFA_CHALLENGE_COOKIE)
  if (!token) return json({ error: 'unauthorized' }, 401)

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const code = presentedCode(body)
  if (!code) return json({ error: 'invalid_code' }, 400)

  let database: Database
  let key: Buffer
  try {
    database = requireDatabase(deps.database)
    key = requireKey(deps.encryptionKey)
  } catch (error) {
    if (error instanceof MfaUnavailableError) return json({ error: 'mfa_unavailable' }, 503)
    return json({ error: 'mfa_failed' }, 500)
  }

  const tokenHash = hashMfaChallengeToken(token)
  const challenges = await database
    .select()
    .from(userMfaChallenges)
    .where(eq(userMfaChallenges.tokenHash, tokenHash))
    .limit(1)
  const challenge = challenges[0]
  if (!challenge) return json({ error: 'unauthorized' }, 401)
  if (challenge.expiresAt.getTime() <= now()) {
    await database.delete(sessions).where(eq(sessions.id, challenge.sessionId))
    await database.delete(userMfaChallenges).where(eq(userMfaChallenges.id, challenge.id))
    const expired = json({ error: 'unauthorized' }, 401)
    expireChallengeCookie(expired, secure)
    return expired
  }

  const limited = rateLimitVerify(challenge.userId, request.headers, deps, log)
  if (limited) return limited

  try {
    const outcome = await database.transaction(async (tx) => {
      const rows = await tx.select().from(userMfa).where(eq(userMfa.userId, challenge.userId)).for('update').limit(1)
      const row = rows[0]
      if (!row?.enabled) return { kind: 'unauthorized' as const }
      return applyPresentedMfaFactor(tx, row, code, key, now(), log)
    })

    if (outcome.kind === 'unauthorized') return json({ error: 'unauthorized' }, 401)
    if (outcome.kind === 'locked') return json({ error: 'too_many_attempts' }, 429)
    if (outcome.kind === 'invalid') return json({ error: 'invalid_code' }, 400)

    let held: { setCookies: string[] }
    try {
      held = JSON.parse(decryptUtf8(challenge.cookiesCiphertext, key)) as { setCookies: string[] }
    } catch {
      log('[hitly mfa] Could not unwrap the held session')
      return json({ error: 'mfa_failed' }, 500)
    }

    await database.delete(userMfaChallenges).where(eq(userMfaChallenges.id, challenge.id))
    const response = json({ ok: true })
    for (const cookie of held.setCookies ?? []) response.headers.append('set-cookie', cookie)
    expireChallengeCookie(response, secure)
    return response
  } catch (error) {
    log(`[hitly mfa] Could not verify MFA: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'mfa_failed' }, 500)
  }
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eqAt = trimmed.indexOf('=')
    if (eqAt <= 0) continue
    if (trimmed.slice(0, eqAt) === name) return decodeURIComponent(trimmed.slice(eqAt + 1))
  }
  return null
}

export { json as mfaJson }
