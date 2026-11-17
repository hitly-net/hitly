/**
 * "Request my data" (UK GDPR right of access): the app captures the ASK, it
 * does not serve the data. The user clicks once; a `support_requests` row of
 * type 'data' records who asked, when, and which workspace context the ask
 * came from. A support engineer then prepares the export and sends it out
 * manually — no personal-data generator lives in this repository.
 *
 * Rules enforced here:
 * - Auth only, own account: the user id comes exclusively from the verified
 *   session; the request body is never read, so there is nothing to forge.
 * - The workspace is the request's active workspace (header, then cookie,
 *   same precedence as lib/api-session.ts) and only after the session user's
 *   membership is confirmed in the database — otherwise null. A caller-
 *   supplied workspace id is never trusted.
 * - Idempotent: an already-open request for the same user and type is
 *   returned unchanged (200). Concurrent clicks are resolved by the partial
 *   unique index (one open row per user+type); the loser of the race reads
 *   back the winner's row and also answers 200.
 * - Rate limited per account before the database is touched
 *   (lib/data-request-limit.ts).
 * - The confirmation names the UK GDPR one-month response deadline:
 *   responseBy = one calendar month after the request (day-of-month clamped
 *   to the target month's last day, the ICO convention).
 */

import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { memberships, supportRequests, workspaces } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { WORKSPACE_HEADER } from './api-session'
import { WORKSPACE_COOKIE } from './context'
import { newId } from './ids'
import { DATA_REQUEST_LIMITED_LOG, DATA_REQUEST_RETRY_AFTER_SECONDS, dataRequestLimiter } from './data-request-limit'

type Database = NonNullable<typeof db>

export const DATA_REQUEST_TYPE = 'data'
export const SUPPORT_REQUEST_OPEN = 'open'
export const DATA_REQUEST_SECURITY_NOTE =
  'The request row stores only ids and timestamps — no personal data and no export content.'

export interface DataRequestDeps {
  getSessionUser?: (headers: Headers) => Promise<{ id: string } | null>
  database?: Database
  allow?: (key: string) => boolean
  log?: (line: string) => void
  now?: () => Date
}

/**
 * UK GDPR response deadline: one calendar month after `from` (the ICO counts
 * to the same calendar day of the following month; when that day does not
 * exist — Jan 31 -> Feb — the deadline is the month's last day).
 */
export function gdprResponseDeadline(from: Date): Date {
  const day = from.getUTCDate()
  const result = new Date(from.getTime())
  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + 1)
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
  result.setUTCDate(Math.min(day, lastDay))
  return result
}

function uniqueViolation(error: unknown): boolean {
  // pg reports the raw SQLSTATE (23505 unique_violation); accept the
  // Prisma-style spelling too so fakes and drivers agree. Drizzle wraps
  // driver errors (DrizzleQueryError), so walk the cause chain as well.
  let node: unknown = error
  for (let depth = 0; node !== null && node !== undefined && depth < 5; depth += 1) {
    const code = typeof node === 'object' ? (node as { code?: unknown }).code : undefined
    if (code === '23505' || code === 'P23505') return true
    node = typeof node === 'object' ? (node as { cause?: unknown; error?: unknown }).cause ?? (node as { error?: unknown }).error : undefined
  }
  return false
}

/** The active-workspace id this request came from (header, then cookie). */
function requestedWorkspaceId(headers: Headers): string | null {
  const header = headers.get(WORKSPACE_HEADER)?.trim()
  if (header) return header
  const cookie = headers.get('cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === WORKSPACE_COOKIE) {
      const value = rest.join('=').trim()
      return value || null
    }
  }
  return null
}

/** Membership-checked active workspace; null when absent, foreign or invalid. */
async function verifiedWorkspaceId(
  database: Database,
  userId: string,
  headers: Headers,
): Promise<string | null> {
  const requested = requestedWorkspaceId(headers)
  if (!requested) return null
  const rows = await database
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, requested)))
    .limit(1)
  return rows.length > 0 ? rows[0].workspaceId : null
}

/**
 * Open support requests of `type` for one user. Shared read surface: the
 * account-deletion preview is meant to call this (with type 'data') so a
 * pending data request can be mentioned before the account is removed.
 */
export async function findOpenSupportRequests(
  database: Database,
  userId: string,
  type: string,
): Promise<Array<{ id: string; workspaceId: string | null; createdAt: Date }>> {
  return database
    .select({ id: supportRequests.id, workspaceId: supportRequests.workspaceId, createdAt: supportRequests.createdAt })
    .from(supportRequests)
    .where(
      and(
        eq(supportRequests.userId, userId),
        eq(supportRequests.type, type),
        eq(supportRequests.status, SUPPORT_REQUEST_OPEN),
      ),
    )
    .limit(1)
}

function openResponseBody(row: { createdAt: Date }): { status: string; requestedAt: string; responseBy: string } {
  const requestedAt = new Date(row.createdAt)
  return {
    status: SUPPORT_REQUEST_OPEN,
    requestedAt: requestedAt.toISOString(),
    responseBy: gdprResponseDeadline(requestedAt).toISOString(),
  }
}

export async function handleDataRequest(
  request: { headers: Headers },
  deps: DataRequestDeps = {},
): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const getSessionUser =
    deps.getSessionUser ??
    (async (headers: Headers) => {
      if (!auth) return null
      const session = await auth.api.getSession({ headers })
      return session?.user ? { id: session.user.id } : null
    })
  const allow = deps.allow ?? dataRequestLimiter
  const now = deps.now ?? (() => new Date())

  // Session first: an anonymous caller must never reach the limiter, the
  // database or consume anyone's bucket.
  let user: { id: string } | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    log(`[hitly data-request] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return NextResponse.json({ error: 'data_request_failed' }, { status: 500 })
  }
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!allow(user.id)) {
    log(DATA_REQUEST_LIMITED_LOG)
    return NextResponse.json(
      { error: 'too_many_requests' },
      { status: 429, headers: { 'retry-after': String(DATA_REQUEST_RETRY_AFTER_SECONDS) } },
    )
  }

  const database = deps.database ?? db
  if (!database) {
    log('[hitly data-request] Database is not configured')
    return NextResponse.json({ error: 'data_request_failed' }, { status: 500 })
  }

  try {
    const open = await findOpenSupportRequests(database, user.id, DATA_REQUEST_TYPE)
    if (open.length > 0) {
      return NextResponse.json(openResponseBody(open[0]), { status: 200 })
    }

    const workspaceId = await verifiedWorkspaceId(database, user.id, request.headers)
    const createdAt = now()
    try {
      await database.insert(supportRequests).values({
        id: newId('srq'),
        userId: user.id,
        workspaceId,
        type: DATA_REQUEST_TYPE,
        status: SUPPORT_REQUEST_OPEN,
        createdAt,
        updatedAt: createdAt,
      })
      return NextResponse.json(openResponseBody({ createdAt }), { status: 201 })
    } catch (error) {
      if (!uniqueViolation(error)) throw error
      // Lost the race against a concurrent click: the winner's open row
      // exists (the partial unique index guarantees it); answer idempotently.
      const winner = await findOpenSupportRequests(database, user.id, DATA_REQUEST_TYPE)
      if (winner.length === 0) throw error
      return NextResponse.json(openResponseBody(winner[0]), { status: 200 })
    }
  } catch (error) {
    log(`[hitly data-request] Request failed: ${error instanceof Error ? error.name : 'error'}`)
    return NextResponse.json({ error: 'data_request_failed' }, { status: 500 })
  }
}
