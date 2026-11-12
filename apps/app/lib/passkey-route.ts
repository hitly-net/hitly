/**
 * The server half of account passkeys: handlers behind /api/session/passkey/*
 * (lib/passkey.ts holds the client-safe helpers the forms import). Server-only
 * imports (auth, the database, WebAuthn verify) stay out of the client bundle
 * by living here.
 *
 * Re-auth for register and delete uses Better Auth's verifyPassword helper
 * the same way signed-in email change and MFA enrol do. A wrong current
 * password answers INVALID_PASSWORD and changes nothing. Rename is session
 * scoped only. A passkey id that is not this user's answers 404 (no
 * existence leak).
 *
 * Registration challenges are single-use and live five minutes (same TTL as
 * MFA half-auth). Successful add/remove write a value-free auth-log line
 * (event name plus user id only). Nothing here logs a password, challenge,
 * or public key: failures use fixed lines.
 */

import { createHash, randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { isAPIError } from 'better-auth/api'
import { base64 } from '@better-auth/utils/base64'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server'
import { accountSecurityEvents, passkeys, verifications } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { newId } from './ids'
import { sendMail } from './mail'
import {
  PASSKEY_CHALLENGE_COOKIE,
  PASSKEY_CHALLENGE_TTL_MS,
  PASSKEY_DEFAULT_NAME,
  PASSKEY_USER_VERIFICATION,
  createSendPasskeyAddedNotice,
  normalisePasskeyName,
  type PasskeyListItem,
} from './passkey'
import { PASSKEY_REAUTH_ATTEMPT_WINDOW_MS, PASSKEY_REAUTH_LIMITED_LOG, passkeyReauthAttemptAcquire } from './passkey-limit'
import { resolveDecision, withRetryAfter, type RateAcquire } from './rate-limit'
import { resetCheckClientKey } from './reset-check-limit'
import { webAuthnRelyingParty } from './webauthn-rp'

type Database = NonNullable<typeof db>

export type PasskeySessionUser = { id: string; email: string; name?: string | null }

export const PASSKEY_SECURITY_EVENT = {
  added: 'passkey_added',
  removed: 'passkey_removed',
} as const

export type PasskeySecurityEventType = (typeof PASSKEY_SECURITY_EVENT)[keyof typeof PASSKEY_SECURITY_EVENT]

export const PASSKEY_ADDED_LOG = `[hitly passkey] ${PASSKEY_SECURITY_EVENT.added}`
export const PASSKEY_REMOVED_LOG = `[hitly passkey] ${PASSKEY_SECURITY_EVENT.removed}`

const REGISTER_CHALLENGE_PREFIX = 'passkey-register:'

type RegisterChallengeValue = {
  type: 'registration'
  expectedChallenge: string
  userId: string
  name: string
}

export interface PasskeyRouteDeps {
  getSessionUser?: (headers: Headers) => Promise<PasskeySessionUser | null>
  verifyPassword?: (headers: Headers, password: string) => Promise<boolean>
  clientKey?: (headers: Headers) => string
  allowReauth?: RateAcquire
  now?: () => number
  database?: Database
  generateRegistrationOptions?: typeof generateRegistrationOptions
  verifyRegistrationResponse?: typeof verifyRegistrationResponse
  notifyAdded?: (user: { email: string }) => Promise<void>
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

function passkeyRowId() {
  return newId('pk').slice(0, 36)
}

export function generatePasskeyChallengeToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashPasskeyChallengeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function registerChallengeIdentifier(tokenHash: string): string {
  return `${REGISTER_CHALLENGE_PREFIX}${tokenHash}`
}

/**
 * Single-statement consume: DELETE ... RETURNING so two concurrent verifies
 * cannot both read the same registration challenge.
 */
export async function consumePasskeyRegisterChallenge(
  database: Database,
  identifier: string,
  nowMs: number,
): Promise<RegisterChallengeValue | null> {
  const rows = await database.delete(verifications).where(eq(verifications.identifier, identifier)).returning()
  const row = rows[0]
  if (!row || row.expiresAt.getTime() <= nowMs) return null
  const stored = JSON.parse(row.value) as RegisterChallengeValue
  if (!stored || stored.type !== 'registration') return null
  return stored
}

function toListItem(row: {
  id: string
  name: string | null
  createdAt: Date
  lastUsedAt: Date | null
}): PasskeyListItem {
  return {
    id: row.id,
    name: row.name?.trim() || PASSKEY_DEFAULT_NAME,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  }
}

function transportsOf(value: string | null | undefined): AuthenticatorTransportFuture[] | undefined {
  if (!value) return undefined
  const parts = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return parts.length ? (parts as AuthenticatorTransportFuture[]) : undefined
}

async function defaultGetSessionUser(headers: Headers): Promise<PasskeySessionUser | null> {
  if (!auth) return null
  const session = await auth.api.getSession({ headers })
  return session?.user
    ? { id: session.user.id, email: session.user.email, name: session.user.name }
    : null
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

async function writeAudit(database: Database, userId: string, type: PasskeySecurityEventType) {
  await database.insert(accountSecurityEvents).values({
    id: passkeyRowId(),
    userId,
    type,
  })
}

function setChallengeCookie(response: NextResponse, token: string) {
  const secure = process.env.NODE_ENV === 'production'
  response.cookies.set(PASSKEY_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(PASSKEY_CHALLENGE_TTL_MS / 1000),
    secure,
  })
}

function expireChallengeCookie(response: NextResponse) {
  const parts = [
    `${PASSKEY_CHALLENGE_COOKIE}=`,
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
    if (!trimmed.startsWith(`${PASSKEY_CHALLENGE_COOKIE}=`)) continue
    return decodeURIComponent(trimmed.slice(`${PASSKEY_CHALLENGE_COOKIE}=`.length))
  }
  return ''
}

type ChangeRequest = { headers: Headers; json: () => Promise<unknown> }

async function requireSession(
  request: ChangeRequest,
  deps: PasskeyRouteDeps,
  logLine: string,
): Promise<{ user: PasskeySessionUser; database: Database } | NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const getSessionUser = deps.getSessionUser ?? defaultGetSessionUser
  let user: PasskeySessionUser | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    log(`${logLine}: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'passkey_failed' }, 500)
  }
  if (!user) return json({ error: 'unauthorized' }, 401)
  try {
    return { user, database: requireDatabase(deps.database) }
  } catch {
    log('[hitly passkey] Database is not configured')
    return json({ error: 'passkey_failed' }, 500)
  }
}

async function requireReauthUser(
  request: ChangeRequest,
  deps: PasskeyRouteDeps,
): Promise<{ user: PasskeySessionUser; database: Database; body: Record<string, unknown> } | NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps, '[hitly passkey] Could not read the session')
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  if (!currentPassword) return json({ code: 'MISSING_FIELDS' }, 400)

  const allow = deps.allowReauth ?? passkeyReauthAttemptAcquire
  const clientKey = deps.clientKey ?? resetCheckClientKey
  const budget = await resolveDecision(allow, clientKey(request.headers), PASSKEY_REAUTH_ATTEMPT_WINDOW_MS)
  if (!budget.allowed) {
    log(PASSKEY_REAUTH_LIMITED_LOG)
    return withRetryAfter(json({ error: 'too_many_attempts' }, 429), budget.retryAfterMs)
  }

  const verifyPassword = deps.verifyPassword ?? defaultVerifyPassword
  let passwordOk: boolean
  try {
    passwordOk = await verifyPassword(request.headers, currentPassword)
  } catch {
    log('[hitly passkey] Password verification failed with an unexpected error')
    return json({ error: 'passkey_failed' }, 500)
  }
  if (!passwordOk) return json({ code: 'INVALID_PASSWORD' }, 400)
  return { user, database, body }
}

export async function listPasskeysForUser(userId: string, deps: PasskeyRouteDeps = {}): Promise<PasskeyListItem[]> {
  const database = requireDatabase(deps.database)
  const rows = await database.select().from(passkeys).where(eq(passkeys.userId, userId))
  return rows
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toListItem)
}

/**
 * GET /api/session/passkey/:id — the signed-in user's passkey, or 404.
 */
export async function handlePasskeyGet(
  request: ChangeRequest,
  id: string,
  deps: PasskeyRouteDeps = {},
): Promise<NextResponse> {
  const prepared = await requireSession(request, deps, '[hitly passkey] Could not read the session')
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  if (!id) return json({ error: 'not_found' }, 404)
  const rows = await database
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
    .limit(1)
  const row = rows[0]
  if (!row) return json({ error: 'not_found' }, 404)
  return json(toListItem(row))
}

/**
 * POST /api/session/passkey/register/options — WebAuthn creation options
 * after a current-password check. The challenge is stored hashed and set
 * on an HttpOnly cookie (five minutes, single use).
 */
export async function handlePasskeyRegisterOptions(
  request: ChangeRequest,
  deps: PasskeyRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireReauthUser(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database, body } = prepared
  const name = normalisePasskeyName(body.name)
  if (!name) return json({ code: 'INVALID_NAME' }, 400)

  const now = deps.now ?? Date.now
  const generate = deps.generateRegistrationOptions ?? generateRegistrationOptions
  const rp = webAuthnRelyingParty()

  try {
    const existing = await database.select().from(passkeys).where(eq(passkeys.userId, user.id))
    const options = await generate({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: user.email,
      userDisplayName: user.name || user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((row) => ({
        id: row.credentialID,
        transports: transportsOf(row.transports),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: PASSKEY_USER_VERIFICATION,
      },
    })

    const token = generatePasskeyChallengeToken()
    const value: RegisterChallengeValue = {
      type: 'registration',
      expectedChallenge: options.challenge,
      userId: user.id,
      name,
    }
    await database.insert(verifications).values({
      id: passkeyRowId(),
      identifier: registerChallengeIdentifier(hashPasskeyChallengeToken(token)),
      value: JSON.stringify(value),
      expiresAt: new Date(now() + PASSKEY_CHALLENGE_TTL_MS),
    })

    const response = json(options)
    setChallengeCookie(response, token)
    return response
  } catch (error) {
    log(`[hitly passkey] Could not start registration: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'passkey_failed' }, 500)
  }
}

/**
 * POST /api/session/passkey/register — verify the authenticator attestation.
 * Consumes the registration challenge first so a replay cannot succeed.
 */
export async function handlePasskeyRegister(
  request: ChangeRequest,
  deps: PasskeyRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps, '[hitly passkey] Could not read the session')
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  const now = deps.now ?? Date.now
  const verify = deps.verifyRegistrationResponse ?? verifyRegistrationResponse
  const notify = deps.notifyAdded ?? createSendPasskeyAddedNotice(sendMail)
  const rp = webAuthnRelyingParty()

  const body = (await request.json().catch(() => ({}))) as {
    response?: RegistrationResponseJSON
    name?: unknown
  }
  const attestation = body.response
  if (!attestation || typeof attestation !== 'object' || typeof attestation.id !== 'string') {
    return json({ error: 'invalid_response' }, 400)
  }

  const token = readChallengeCookie(request.headers)
  if (!token) {
    const missing = json({ error: 'challenge_not_found' }, 400)
    expireChallengeCookie(missing)
    return missing
  }

  const identifier = registerChallengeIdentifier(hashPasskeyChallengeToken(token))
  let stored: RegisterChallengeValue | null = null
  try {
    stored = await consumePasskeyRegisterChallenge(database, identifier, now())
  } catch (error) {
    log(`[hitly passkey] Could not consume the registration challenge: ${error instanceof Error ? error.name : 'error'}`)
    const failed = json({ error: 'passkey_failed' }, 500)
    expireChallengeCookie(failed)
    return failed
  }
  if (!stored) {
    const expired = json({ error: 'challenge_not_found' }, 400)
    expireChallengeCookie(expired)
    return expired
  }

  if (stored.userId !== user.id) {
    const rejected = json({ error: 'challenge_not_found' }, 400)
    expireChallengeCookie(rejected)
    return rejected
  }

  const name = normalisePasskeyName(body.name) ?? stored.name
  if (!name) {
    const invalid = json({ code: 'INVALID_NAME' }, 400)
    expireChallengeCookie(invalid)
    return invalid
  }

  let verification: VerifiedRegistrationResponse
  try {
    verification = await verify({
      response: attestation,
      expectedChallenge: stored.expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    })
  } catch {
    const failed = json({ error: 'verification_failed' }, 400)
    expireChallengeCookie(failed)
    return failed
  }

  const info = verification.registrationInfo
  if (!verification.verified || !info) {
    const failed = json({ error: 'verification_failed' }, 400)
    expireChallengeCookie(failed)
    return failed
  }

  const credential = info.credential
  try {
    const duplicate = await database
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialID, credential.id))
      .limit(1)
    if (duplicate[0]) {
      const conflict = json({ error: 'already_registered' }, 409)
      expireChallengeCookie(conflict)
      return conflict
    }

    const created = {
      id: passkeyRowId(),
      name,
      publicKey: base64.encode(credential.publicKey),
      userId: user.id,
      credentialID: credential.id,
      counter: credential.counter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      transports: Array.isArray(attestation.response?.transports)
        ? (attestation.response.transports as string[]).join(',')
        : '',
      aaguid: info.aaguid,
      createdAt: new Date(),
      lastUsedAt: null as Date | null,
    }
    await database.insert(passkeys).values(created)
    await writeAudit(database, user.id, PASSKEY_SECURITY_EVENT.added)
    log(`${PASSKEY_ADDED_LOG} user=${user.id}`)
    void notify({ email: user.email }).catch(() => {
      log('[hitly passkey] Could not queue the passkey-added email')
    })
    const response = json({ ok: true, passkey: toListItem(created) })
    expireChallengeCookie(response)
    return response
  } catch (error) {
    log(`[hitly passkey] Could not store the passkey: ${error instanceof Error ? error.name : 'error'}`)
    const failed = json({ error: 'passkey_failed' }, 500)
    expireChallengeCookie(failed)
    return failed
  }
}

/**
 * POST /api/session/passkey/:id — rename. Session required; 404 if not owned.
 */
export async function handlePasskeyRename(
  request: ChangeRequest,
  id: string,
  deps: PasskeyRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireSession(request, deps, '[hitly passkey] Could not read the session')
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  if (!id) return json({ error: 'not_found' }, 404)

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const name = normalisePasskeyName(body.name)
  if (!name) return json({ code: 'INVALID_NAME' }, 400)

  try {
    const rows = await database
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
      .limit(1)
    if (!rows[0]) return json({ error: 'not_found' }, 404)
    await database.update(passkeys).set({ name }).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
    return json({ ok: true })
  } catch (error) {
    log(`[hitly passkey] Could not rename the passkey: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'passkey_failed' }, 500)
  }
}

/**
 * POST /api/session/passkey/:id/delete — current-password check, then
 * delete. 404 if the id is not this user's.
 */
export async function handlePasskeyDelete(
  request: ChangeRequest,
  id: string,
  deps: PasskeyRouteDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const prepared = await requireReauthUser(request, deps)
  if (prepared instanceof NextResponse) return prepared
  const { user, database } = prepared
  if (!id) return json({ error: 'not_found' }, 404)

  try {
    const rows = await database
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
      .limit(1)
    if (!rows[0]) return json({ error: 'not_found' }, 404)
    await database.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
    await writeAudit(database, user.id, PASSKEY_SECURITY_EVENT.removed)
    log(`${PASSKEY_REMOVED_LOG} user=${user.id}`)
    return json({ ok: true })
  } catch (error) {
    log(`[hitly passkey] Could not delete the passkey: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: 'passkey_failed' }, 500)
  }
}

export type { PublicKeyCredentialCreationOptionsJSON }
