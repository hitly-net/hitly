import { NextResponse } from 'next/server'
import { appOwnOrigin } from './cors'
import { applyRestLimit, hashRestSubject } from './rest-limit'
import { normaliseEmail } from './invite-signup'
import {
  acceptInviteAsUser,
  acceptInviteWithNewAccount,
  emailsMatch,
  isWellFormedInviteToken,
  lookupInvite,
  refusalMessage,
  refusalStatus,
} from './invites'
import { MIN_PASSWORD_LENGTH } from './password-reset'

export const WORKSPACE_COOKIE = 'hitly-workspace-id'

type SessionUser = { id: string; email: string }

/**
 * What the invite routes need from Better Auth, injectable so tests can run
 * the real database logic with a real or stub auth instance.
 */
export type InviteRouteDeps = {
  getSessionUser: (request: Request) => Promise<SessionUser | null>
  findUserIdByEmail: (email: string) => Promise<string | null>
  signUp: (
    request: Request,
    body: { email: string; name: string; password: string },
  ) => Promise<{ userId: string; setCookies: string[] }>
}

function json(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status })
  response.headers.set('cache-control', 'no-store')
  response.headers.set('referrer-policy', 'no-referrer')
  return response
}

/**
 * Same-origin JSON only: a cross-site page cannot submit JSON without a
 * preflight, and a request that names another Origin is refused outright.
 */
function rejectCrossSite(request: Request): NextResponse | null {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return json({ error: 'Expected application/json' }, 415)
  }
  const origin = request.headers.get('origin')
  if (origin && origin !== appOwnOrigin()) {
    return json({ error: 'Forbidden' }, 403)
  }
  return null
}

async function readToken(request: Request): Promise<{ token: unknown; body: Record<string, unknown> }> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  return { token: body?.token, body: body ?? {} }
}

function refusal(reason: Parameters<typeof refusalMessage>[0]) {
  return json({ ok: false, reason, error: refusalMessage(reason) }, refusalStatus(reason))
}

/** POST /api/v1/invites/lookup — describes a token without consuming it. */
export async function handleInviteLookup(request: Request, deps: InviteRouteDeps) {
  const blocked = rejectCrossSite(request)
  if (blocked) return blocked
  const { token } = await readToken(request)
  const limited = await applyRestLimit('invite', hashRestSubject('invite:' + String(token)))
  if (limited) return limited
  const lookup = await lookupInvite(token)
  if (!lookup.ok) return refusal(lookup.reason)
  const session = await deps.getSessionUser(request)
  const invitedEmail = normaliseEmail(lookup.invite.email)
  return json({
    ok: true,
    workspaceName: lookup.workspaceName,
    email: invitedEmail,
    expiresAt: lookup.invite.expiresAt.toISOString(),
    accountExists: (await deps.findUserIdByEmail(invitedEmail)) !== null,
    signedInEmail: session ? normaliseEmail(session.email) : null,
    emailMatches: session ? emailsMatch(session.email, invitedEmail) : null,
  })
}

function joined(workspaceId: string, setCookies: string[] = []) {
  const response = json({ ok: true, workspaceId, redirectTo: '/inbox' })
  // cookies.set rewrites the set-cookie header, so it goes before the raw session cookies.
  response.cookies.set(WORKSPACE_COOKIE, workspaceId, { path: '/', sameSite: 'lax' })
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
  return response
}

/**
 * POST /api/v1/invites/accept
 * - Signed in: joins the workspace if the account email matches the invite.
 * - Not signed in, with name + password: creates the account for the invited
 *   email (allowed even when public signup is off) and joins.
 */
export async function handleInviteAccept(request: Request, deps: InviteRouteDeps) {
  const blocked = rejectCrossSite(request)
  if (blocked) return blocked
  const { token, body } = await readToken(request)
  const limited = await applyRestLimit('invite', hashRestSubject('invite:' + String(token)))
  if (limited) return limited
  if (!isWellFormedInviteToken(token)) return refusal('invalid')

  const session = await deps.getSessionUser(request)
  if (session) {
    const result = await acceptInviteAsUser(token, session)
    return result.ok ? joined(result.workspaceId) : refusal(result.reason)
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!name || name.length > 255) return json({ ok: false, error: 'Enter your name.' }, 400)
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json({ ok: false, error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.` }, 400)
  }

  try {
    const result = await acceptInviteWithNewAccount(token, async (email) => {
      const created = await deps.signUp(request, { email, name, password })
      return { userId: created.userId, result: created.setCookies }
    })
    return result.ok ? joined(result.workspaceId, result.result) : refusal(result.reason)
  } catch {
    // The invite was released, so the same link can be retried. Log no
    // request detail: the body carries the token and the password.
    console.error('[hitly invite] account creation failed')
    return json({ ok: false, error: 'Could not create the account. Check the details and try again.' }, 400)
  }
}
