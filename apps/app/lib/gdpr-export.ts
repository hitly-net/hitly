/**
 * GDPR data export (product ruling HG-5): builds the user's personal data
 * bundle as a set of JSON files zipped into a single download.
 *
 * What ships (and what must NEVER appear in the zip):
 * - profile, own sessions (device fields only, never the session token),
 *   provider/account list (never password hashes or OAuth tokens),
 *   workspaces + roles, projects (names/roles only, never credentials,
 *   rules or channel config), own push tokens/devices (prefix only, never
 *   the raw token value), invites the user sent, security events.
 * - Approvals the user was assigned, was shown (presented) or decided are
 *   limited to what the UI showed them: title (actionName), the reviewer
 *   prompt/context, status, timestamps, and their OWN decision record
 *   (decision, reason, answer). Raw request payloads (envelope.action.args),
 *   evidence, edit diffs, third-party contacts and envelope metadata are
 *   excluded — the allow-list below is the only path data takes.
 *
 * Limits: EXPORT_TABLE_ROW_LIMIT rows per table and EXPORT_ZIP_MAX_BYTES for
 * the archive (413 when exceeded); the manifest carries a truncated flag.
 * A successful export writes one data_export account-security event (type +
 * user id only) — no file contents, no counts of other people's data.
 */

import { desc, eq, inArray, or } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import {
  accountSecurityEvents,
  accounts,
  approvals,
  decisionRecords,
  invites,
  memberships,
  projects,
  projectMemberships,
  pushTokens,
  sessions,
  userDevices,
  users,
  workspaces,
} from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import { newId } from './ids'
import { decodeTenantJson } from './tenant-crypto'
import { EXPORT_LIMITED_LOG, EXPORT_RETRY_AFTER_SECONDS, exportLimiter } from './gdpr-export-limit'
import { createZip, type ZipEntry } from './zip'

type Database = NonNullable<typeof db>

export const EXPORT_TABLE_ROW_LIMIT = 10_000
export const EXPORT_ZIP_MAX_BYTES = 25 * 1024 * 1024
export const EXPORT_SECURITY_EVENT_TYPE = 'data_export'
/** Only this prefix of a push token is exported (device identification). */
export const PUSH_TOKEN_PREFIX_LENGTH = 12

export type ExportSessionUser = { id: string }

export interface ExportDeps {
  getSessionUser?: (headers: Headers) => Promise<ExportSessionUser | null>
  database?: Database
  allow?: (key: string) => boolean
  log?: (line: string) => void
}

type Row = Record<string, unknown>

function capped<T extends Row[]>(rows: T, limit = EXPORT_TABLE_ROW_LIMIT): { rows: T; truncated: boolean } {
  if (rows.length <= limit) return { rows, truncated: false }
  return { rows: rows.slice(0, limit) as T, truncated: true }
}

/**
 * Allow-list projection for an approval the user touched. Everything not
 * listed here is dropped, including envelope.action (raw args), metadata,
 * externalUrls, attachments, origin, evidence and other reviewers' rows.
 */
export function projectApprovalForExport(
  row: {
    id: string
    workspaceId: string
    projectId: string
    plugin: string
    status: string
    actionName: string
    createdAt: Date | string
    presentedAt: Date | string | null
    expiresAt: Date | string | null
    updatedAt: Date | string | null
  },
  envelope: Row,
  roles: string[],
  ownDecisions: Array<{ decision: string; payload: Row; createdAt: Date | string }>,
): Row {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    plugin: row.plugin,
    status: row.status,
    title: row.actionName,
    prompt: typeof envelope.prompt === 'string' ? envelope.prompt : null,
    contextMarkdown: typeof envelope.contextMarkdown === 'string' ? envelope.contextMarkdown : null,
    createdAt: row.createdAt,
    presentedAt: row.presentedAt,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    roles,
    decisions: ownDecisions.map((d) => ({
      decision: d.decision,
      reason: typeof d.payload.reason === 'string' ? d.payload.reason : null,
      answer: d.payload.answer === undefined || d.payload.answer === null ? null : d.payload.answer,
      createdAt: d.createdAt,
    })),
  }
}

export type ExportBuildResult = {
  entries: ZipEntry[]
  truncated: boolean
  counts: Record<string, number>
}

/** Collect the user's data as JSON files. Pure read path (plus the caller's
 * security-event insert) — safe to call from tests with an injected database. */
export async function buildExportFiles(
  database: Database,
  userId: string,
  now = new Date(),
): Promise<ExportBuildResult> {
  const [userRows, sessionRows, accountRows, workspaceRows, projectRows, deviceRows, pushRows, inviteRows, eventRows] =
    await Promise.all([
      database.select().from(users).where(eq(users.id, userId)).limit(1),
      database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.createdAt))
        .limit(EXPORT_TABLE_ROW_LIMIT + 1),
      database.select().from(accounts).where(eq(accounts.userId, userId)).limit(EXPORT_TABLE_ROW_LIMIT + 1),
      database
        .select({
          workspaceId: workspaces.id,
          name: workspaces.name,
          slug: workspaces.slug,
          role: memberships.role,
          memberSince: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .where(eq(memberships.userId, userId))
        .limit(EXPORT_TABLE_ROW_LIMIT + 1),
      database
        .select({
          projectId: projects.id,
          workspaceId: projects.workspaceId,
          name: projects.name,
          plugin: projects.plugin,
          status: projects.status,
          role: projectMemberships.role,
          memberSince: projectMemberships.createdAt,
        })
        .from(projectMemberships)
        .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
        .where(eq(projectMemberships.userId, userId))
        .limit(EXPORT_TABLE_ROW_LIMIT + 1),
      database
        .select()
        .from(userDevices)
        .where(eq(userDevices.userId, userId))
        .limit(EXPORT_TABLE_ROW_LIMIT + 1),
      database
        .select()
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId))
        .limit(EXPORT_TABLE_ROW_LIMIT + 1),
      database
        .select()
        .from(invites)
        .where(eq(invites.invitedByUserId, userId))
        .limit(EXPORT_TABLE_ROW_LIMIT + 1),
      database
        .select()
        .from(accountSecurityEvents)
        .where(eq(accountSecurityEvents.userId, userId))
        .orderBy(desc(accountSecurityEvents.createdAt))
        .limit(EXPORT_TABLE_ROW_LIMIT + 1),
    ])

  const user = userRows[0]
  if (!user) throw new Error('export_user_not_found')

  const ownDecisionRows = capped(
    await database
      .select()
      .from(decisionRecords)
      .where(eq(decisionRecords.actorUserId, userId))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(EXPORT_TABLE_ROW_LIMIT + 1),
  )

  const involvedIds = Array.from(new Set(ownDecisionRows.rows.map((r) => r.approvalId)))
  const involvementRows = involvedIds.length
    ? capped(
        await database
          .select()
          .from(approvals)
          .where(
            or(
              eq(approvals.assignedUserId, userId),
              eq(approvals.presentedByUserId, userId),
              inArray(approvals.id, involvedIds),
            ),
          )
          .orderBy(desc(approvals.createdAt))
          .limit(EXPORT_TABLE_ROW_LIMIT + 1),
      )
    : capped([] as (typeof approvals.$inferSelect)[])

  const decisionsByApproval = new Map<
    string,
    Array<{ decision: string; payload: Row; createdAt: Date | string }>
  >()
  for (const record of ownDecisionRows.rows) {
    const list = decisionsByApproval.get(record.approvalId) ?? []
    list.push({
      decision: record.decision,
      payload: (record.payload ?? {}) as Row,
      createdAt: record.createdAt,
    })
    decisionsByApproval.set(record.approvalId, list)
  }

  const approvalFiles: Row[] = []
  for (const row of involvementRows.rows) {
    const roles: string[] = []
    if (row.assignedUserId === userId) roles.push('assigned')
    if (row.presentedByUserId === userId) roles.push('presented')
    if (decisionsByApproval.has(row.id)) roles.push('decided')
    if (roles.length === 0) continue
    const envelope = (await decodeTenantJson(row.workspaceId, row.envelope as never)) as Row
    approvalFiles.push(projectApprovalForExport(row, envelope, roles, decisionsByApproval.get(row.id) ?? []))
  }

  // Cap each collection ONCE: the truncated flag must reflect the same
  // result the files use (calling capped() twice hid overflow before).
  const caps = {
    sessions: capped(sessionRows),
    accounts: capped(accountRows),
    workspaces: capped(workspaceRows),
    projects: capped(projectRows),
    devices: capped(deviceRows),
    pushTokens: capped(pushRows),
    sentInvites: capped(inviteRows),
    securityEvents: capped(eventRows),
  }

  const sections: Record<string, unknown> = {
    profile: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    sessions: caps.sessions.rows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      expiresAt: s.expiresAt,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
    })),
    accounts: caps.accounts.rows.map((a) => ({
      providerId: a.providerId,
      accountId: a.accountId,
      scope: a.scope,
      hasPassword: Boolean(a.password),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    workspaces: caps.workspaces.rows,
    projects: caps.projects.rows,
    devices: caps.devices.rows.map((d) => ({
      platform: d.platform,
      tokenPrefix: String(d.expoPushToken).slice(0, PUSH_TOKEN_PREFIX_LENGTH),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    pushTokens: caps.pushTokens.rows.map((t) => ({
      platform: t.platform,
      tokenPrefix: String(t.token).slice(0, PUSH_TOKEN_PREFIX_LENGTH),
      createdAt: t.createdAt,
      lastSeenAt: t.lastSeenAt,
    })),
    sentInvites: caps.sentInvites.rows.map((i) => ({
      id: i.id,
      workspaceId: i.workspaceId,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      acceptedAt: i.acceptedAt,
      expiresAt: i.expiresAt,
    })),
    securityEvents: caps.securityEvents.rows.map((e) => ({ type: e.type, createdAt: e.createdAt })),
    approvals: approvalFiles,
  }

  const truncated = [
    caps.sessions,
    caps.accounts,
    caps.workspaces,
    caps.projects,
    caps.devices,
    caps.pushTokens,
    caps.sentInvites,
    caps.securityEvents,
    ownDecisionRows,
    involvementRows,
  ].some((s) => s.truncated === true)

  const counts: Record<string, number> = {}
  const entries: ZipEntry[] = []
  for (const [name, value] of Object.entries(sections)) {
    counts[name] = Array.isArray(value) ? value.length : 1
    entries.push({
      name: `${name}.json`,
      data: new TextEncoder().encode(JSON.stringify(value, null, 2)),
    })
  }

  const manifest = {
    kind: 'hitly-data-export',
    version: 1,
    generatedAt: now.toISOString(),
    userId: user.id,
    rowLimit: EXPORT_TABLE_ROW_LIMIT,
    zipMaxBytes: EXPORT_ZIP_MAX_BYTES,
    truncated,
    files: counts,
  }
  entries.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) })

  return { entries, truncated, counts }
}

function zipResponse(zip: Buffer, truncated: boolean, now: Date): NextResponse {
  const filename = `hitly-data-export-${now.toISOString().slice(0, 10)}.zip`
  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-hitly-export-truncated': truncated ? '1' : '0',
    },
  })
}

/**
 * POST /api/session/export. Session-authenticated; one export per user per
 * hour (429 + Retry-After). Returns the zip or a fixed error code. Never
 * logs exported content.
 */
export async function handleDataExport(request: { headers: Headers }, deps: ExportDeps = {}): Promise<NextResponse> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const getSessionUser =
    deps.getSessionUser ??
    (async (headers: Headers) => {
      if (!auth) return null
      const session = await auth.api.getSession({ headers })
      return session?.user ? { id: session.user.id } : null
    })
  const allow = deps.allow ?? exportLimiter

  let user: ExportSessionUser | null
  try {
    user = await getSessionUser(request.headers)
  } catch (error) {
    log(`[hitly gdpr-export] Could not read the session: ${error instanceof Error ? error.name : 'error'}`)
    return NextResponse.json({ error: 'export_failed' }, { status: 500 })
  }
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!allow(user.id)) {
    log(EXPORT_LIMITED_LOG)
    return NextResponse.json(
      { error: 'too_many_requests' },
      { status: 429, headers: { 'retry-after': String(EXPORT_RETRY_AFTER_SECONDS) } },
    )
  }

  const database = deps.database ?? db
  if (!database) {
    log('[hitly gdpr-export] Database is not configured')
    return NextResponse.json({ error: 'export_failed' }, { status: 500 })
  }

  const now = new Date()
  let built: ExportBuildResult
  try {
    built = await buildExportFiles(database, user.id, now)
  } catch (error) {
    log(`[hitly gdpr-export] Export build failed: ${error instanceof Error ? error.name : 'error'}`)
    return NextResponse.json({ error: 'export_failed' }, { status: 500 })
  }

  const zip = createZip(built.entries, now)
  if (zip.byteLength > EXPORT_ZIP_MAX_BYTES) {
    log('[hitly gdpr-export] Export refused: archive exceeds the size cap')
    return NextResponse.json({ error: 'export_too_large' }, { status: 413 })
  }

  try {
    await database.insert(accountSecurityEvents).values({ id: newId('ase'), userId: user.id, type: EXPORT_SECURITY_EVENT_TYPE })
  } catch (error) {
    // The export itself succeeded; the audit line failing must not undo it.
    log(`[hitly gdpr-export] Could not record the export event: ${error instanceof Error ? error.name : 'error'}`)
  }

  return zipResponse(zip, built.truncated, now)
}
