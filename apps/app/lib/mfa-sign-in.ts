/**
 * After a successful email/password sign-in, if the account has MFA enabled
 * the Better Auth session is held server-side and the client receives only a
 * short-lived challenge cookie. The half-auth cookie is not a session and
 * cannot pass getSession / requireApiSession / page guards.
 *
 * Fail closed: if MFA status cannot be read, or the wrapping key is missing
 * while MFA is on, the session is revoked and no session cookie is forwarded.
 */

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { sessions, userMfaChallenges } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import {
  generateMfaChallengeToken,
  hashMfaChallengeToken,
  isMfaEnabled,
  mfaJson,
  type MfaRouteDeps,
} from './mfa-route'
import { MFA_CHALLENGE_COOKIE, MFA_CHALLENGE_TTL_MS } from './mfa'
import { encryptUtf8, mfaEncryptionKeyProblem, MFA_ENCRYPTION_KEY_ENV, resolveMfaEncryptionKey } from './mfa-crypto'
import { newId } from './ids'

export function isEmailPasswordSignIn(request: Request): boolean {
  try {
    const pathname = new URL(request.url).pathname
    return request.method === 'POST' && pathname.endsWith('/sign-in/email')
  } catch {
    return false
  }
}

function replayJson(response: Response, body: unknown): NextResponse {
  const next = NextResponse.json(body, { status: response.status })
  for (const cookie of response.headers.getSetCookie()) next.headers.append('set-cookie', cookie)
  const cache = response.headers.get('cache-control')
  if (cache) next.headers.set('cache-control', cache)
  next.headers.set('referrer-policy', 'no-referrer')
  return next
}

async function revokeCookies(setCookies: string[]) {
  if (!auth) return
  const cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ')
  if (!cookie) return
  try {
    await auth.api.signOut({ headers: new Headers({ cookie }) })
  } catch {
    // The held session is dropped below by id when we have one.
  }
}

export async function holdPasswordSignInIfMfa(
  request: Request,
  response: Response,
  deps: MfaRouteDeps = {},
): Promise<Response> {
  if (!isEmailPasswordSignIn(request) || response.status !== 200) return response

  const log = deps.log ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const data = (await response.json().catch(() => null)) as { user?: { id?: string } } | null
  const userId = typeof data?.user?.id === 'string' ? data.user.id : ''
  if (!userId) return replayJson(response, data ?? {})

  let enabled: boolean
  try {
    enabled = await isMfaEnabled(userId, deps)
  } catch (error) {
    log(`[hitly mfa] Could not read MFA status at sign-in: ${error instanceof Error ? error.name : 'error'}`)
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }
  if (!enabled) return replayJson(response, data)

  const database = deps.database ?? db
  if (!database) {
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  if (mfaEncryptionKeyProblem(process.env[MFA_ENCRYPTION_KEY_ENV]) && !deps.encryptionKey) {
    log('[hitly mfa] Encryption key is not configured; sign-in with MFA refused')
    await revokeCookies(setCookies)
    return mfaJson({ error: 'mfa_unavailable' }, 503)
  }

  const cookieHeader = setCookies.map((entry) => entry.split(';')[0]).join('; ')
  if (!auth) {
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  let sessionId: string | null = null
  try {
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader }) })
    sessionId = session?.session?.id ?? null
  } catch (error) {
    log(`[hitly mfa] Could not read the new session: ${error instanceof Error ? error.name : 'error'}`)
  }
  if (!sessionId) {
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  const key = deps.encryptionKey ?? resolveMfaEncryptionKey()
  const token = generateMfaChallengeToken()
  const secure = process.env.NODE_ENV === 'production'

  try {
    const previous = await database.select().from(userMfaChallenges).where(eq(userMfaChallenges.userId, userId))
    for (const row of previous) {
      await database.delete(sessions).where(eq(sessions.id, row.sessionId))
    }
    await database.delete(userMfaChallenges).where(eq(userMfaChallenges.userId, userId))
    await database.insert(userMfaChallenges).values({
      id: newId('mfc').slice(0, 36),
      userId,
      tokenHash: hashMfaChallengeToken(token),
      sessionId,
      cookiesCiphertext: encryptUtf8(JSON.stringify({ setCookies, sessionId }), key),
      expiresAt: new Date(now() + MFA_CHALLENGE_TTL_MS),
    })
  } catch (error) {
    log(`[hitly mfa] Could not hold the sign-in for MFA: ${error instanceof Error ? error.name : 'error'}`)
    await revokeCookies(setCookies)
    return mfaJson({ error: 'sign_in_failed' }, 500)
  }

  const held = mfaJson({ mfaRequired: true })
  held.cookies.set(MFA_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(MFA_CHALLENGE_TTL_MS / 1000),
    secure,
  })
  return held
}
