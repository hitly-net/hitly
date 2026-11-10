import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm'
import { clampListLimit, decodeListCursor, olderThanListCursor, takeListPage, type ListCursor } from './list-cursor'
import { AWAITING_HUMAN_APPROVAL_STATUSES, CLOSED_APPROVAL_STATUSES, isDecision, type WorkspaceRole } from '@hitly/core'
import { approvals, decisionRecords, projects, users } from '@hitly/db/schema'
import { listVisibleProjectIds } from './rbac'
import { requireDb, withTenant } from './tenant'
import { INBOX_SCOPES, isInboxScope, type InboxScope } from './list-filters'

export const AUDIT_SORTS = ['createdAt', 'decision', 'actionName', 'projectName', 'actorName'] as const
export type AuditSort = (typeof AUDIT_SORTS)[number]

function isAuditSort(value: string | undefined): value is AuditSort {
  return Boolean(value && (AUDIT_SORTS as readonly string[]).includes(value))
}

function likeTerm(q: string) {
  const trimmed = q.replace(/[%_\\]/g, '').trim()
  return trimmed ? `%${trimmed}%` : null
}

export type { InboxScope }
export { INBOX_SCOPES }

/** Allowlisted inbox-row fields. Never envelope/origin/payload. */
export const INBOX_LIST_KEYS = [
  'id',
  'status',
  'actionName',
  'plugin',
  'projectId',
  'projectName',
  'createdAt',
  'expiresAt',
  'decision',
] as const

export type InboxListItem = {
  id: string
  status: string
  actionName: string
  plugin: string
  projectId: string
  projectName: string
  createdAt: Date
  expiresAt: Date | null
  decision: string | null
}

export function toInboxListItem(row: InboxListItem): InboxListItem {
  return {
    id: row.id,
    status: row.status,
    actionName: row.actionName,
    plugin: row.plugin,
    projectId: row.projectId,
    projectName: row.projectName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decision: row.decision,
  }
}

export function serializeInboxList(items: InboxListItem[]): string {
  return JSON.stringify(items)
}

export const INBOX_DEFAULT_LIMIT = 100
export const INBOX_MAX_LIMIT = 200

export async function listInboxItems(args: {
  workspaceId: string
  userId: string
  workspaceRole: WorkspaceRole
  projectId?: string
  scope?: string
  q?: string
  limit?: number
  cursor?: ListCursor
}): Promise<{ items: InboxListItem[]; nextCursor: string | null }> {
  return withTenant(args.workspaceId, async () => {
    const visibleIds = await listVisibleProjectIds(args)
    const projectIds = args.projectId ? visibleIds.filter((id) => id === args.projectId) : visibleIds
    if (projectIds.length === 0) return { items: [], nextCursor: null }
    const database = requireDb()
    const limit = clampListLimit(args.limit, INBOX_DEFAULT_LIMIT, INBOX_MAX_LIMIT)
    const filters = [eq(approvals.workspaceId, args.workspaceId), inArray(approvals.projectId, projectIds)]
  const scope = isInboxScope(args.scope) ? args.scope : 'all'
  if (scope === 'open') {
    // Pending inbox (web + mobile): only items still awaiting a human.
    // failed_resume rows already carry a human decision and must not appear.
    filters.push(inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES]))
  } else if (scope === 'closed') {
    filters.push(inArray(approvals.status, [...CLOSED_APPROVAL_STATUSES]))
  }
  const term = args.q ? likeTerm(args.q) : null
  if (term) {
    const search = or(ilike(approvals.actionName, term), ilike(projects.name, term))
    if (search) filters.push(search)
  }
  const cursorWhere = args.cursor ? olderThanListCursor(approvals.createdAt, approvals.id, args.cursor) : undefined
  if (cursorWhere) filters.push(cursorWhere)
  const rows = await database
    .select({
      id: approvals.id,
      status: approvals.status,
      actionName: approvals.actionName,
      plugin: approvals.plugin,
      projectId: approvals.projectId,
      projectName: projects.name,
      createdAt: approvals.createdAt,
      expiresAt: approvals.expiresAt,
      decision: sql<string | null>`(
        select ${decisionRecords.decision}
        from ${decisionRecords}
        where ${decisionRecords.approvalId} = ${approvals.id}
        order by ${decisionRecords.createdAt} desc
        limit 1
      )`.as('decision'),
    })
    .from(approvals)
    .innerJoin(projects, eq(approvals.projectId, projects.id))
    .where(and(...filters))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(limit + 1)
  const { page, nextCursor } = takeListPage(rows, limit)
  return { items: page.map(toInboxListItem), nextCursor }
  })
}

/**
 * Cap for server-rendered inbox and project item lists. Each request uses
 * INBOX_DEFAULT_LIMIT (100); this helper follows `nextCursor` until exhausted
 * or this cap. `hasMore` is set when rows remain so the UI never silently truncates.
 */
export const WEB_INBOX_FETCH_CAP = 500

export async function listInboxItemsForWeb(
  args: Omit<Parameters<typeof listInboxItems>[0], 'limit' | 'cursor'>,
  cap: number = WEB_INBOX_FETCH_CAP,
): Promise<{ items: InboxListItem[]; nextCursor: string | null; hasMore: boolean }> {
  const items: InboxListItem[] = []
  let cursor: ListCursor | undefined
  let nextCursor: string | null = null
  const safeCap = Math.max(1, Math.trunc(cap))
  while (items.length < safeCap) {
    const page = await listInboxItems({
      ...args,
      limit: Math.min(INBOX_DEFAULT_LIMIT, safeCap - items.length),
      cursor,
    })
    items.push(...page.items)
    nextCursor = page.nextCursor
    if (!nextCursor || page.items.length === 0) break
    const decoded = decodeListCursor(nextCursor)
    if (!decoded) break
    cursor = decoded
  }
  return { items, nextCursor, hasMore: Boolean(nextCursor) }
}

export async function inboxSummary(args: {
  workspaceId: string
  userId: string
  workspaceRole: WorkspaceRole
  projectId?: string
}) {
  return withTenant(args.workspaceId, async () => {
    const visibleIds = await listVisibleProjectIds(args)
    const projectIds = args.projectId ? visibleIds.filter((id) => id === args.projectId) : visibleIds
    if (projectIds.length === 0) {
      return { pending: 0, failedResume: 0, decidedToday: 0, projectCount: 0 }
    }
  const database = requireDb()
  const pendingRows = await database
    .select({ count: sql<number>`count(*)` })
    .from(approvals)
    .where(
      and(
        inArray(approvals.projectId, projectIds),
        eq(approvals.workspaceId, args.workspaceId),
        inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES]),
      ),
    )
  const failedRows = await database
    .select({ count: sql<number>`count(*)` })
    .from(approvals)
    .where(and(inArray(approvals.projectId, projectIds), eq(approvals.workspaceId, args.workspaceId), eq(approvals.status, 'failed_resume')))
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const decidedRows = await database
    .select({ count: sql<number>`count(*)` })
    .from(approvals)
    .where(
      and(
        inArray(approvals.projectId, projectIds),
        eq(approvals.workspaceId, args.workspaceId),
        eq(approvals.status, 'decided'),
        gte(approvals.updatedAt, start),
      ),
    )
  return {
    pending: Number(pendingRows[0]?.count ?? 0),
    failedResume: Number(failedRows[0]?.count ?? 0),
    decidedToday: Number(decidedRows[0]?.count ?? 0),
    projectCount: projectIds.length,
  }
  })
}

export async function listAudit(args: {
  workspaceId: string
  userId: string
  workspaceRole: WorkspaceRole
  q?: string
  projectId?: string
  decision?: string
  sort?: string
  dir?: string
}) {
  return withTenant(args.workspaceId, async () => {
    const visibleIds = await listVisibleProjectIds(args)
    const projectIds = args.projectId ? visibleIds.filter((id) => id === args.projectId) : visibleIds
    if (projectIds.length === 0) return []
    const database = requireDb()
    const filters = [
      eq(decisionRecords.workspaceId, args.workspaceId),
      eq(approvals.workspaceId, args.workspaceId),
      inArray(approvals.projectId, projectIds),
    ]
  if (args.decision && isDecision(args.decision)) {
    filters.push(eq(decisionRecords.decision, args.decision))
  }
  const term = args.q ? likeTerm(args.q) : null
  if (term) {
    const search = or(
      ilike(approvals.actionName, term),
      ilike(projects.name, term),
      ilike(users.name, term),
      ilike(users.email, term),
    )
    if (search) filters.push(search)
  }
  const sort: AuditSort = isAuditSort(args.sort) ? args.sort : 'createdAt'
  const direction = args.dir === 'asc' ? asc : desc
  const sortColumn = {
    createdAt: decisionRecords.createdAt,
    decision: decisionRecords.decision,
    actionName: approvals.actionName,
    projectName: projects.name,
    actorName: users.name,
  }[sort]
  const rows = await database
    .select({
      id: decisionRecords.id,
      decision: decisionRecords.decision,
      createdAt: decisionRecords.createdAt,
      approvalId: decisionRecords.approvalId,
      actionName: approvals.actionName,
      projectId: approvals.projectId,
      projectName: projects.name,
      actorName: users.name,
      actorEmail: users.email,
      resumeError: decisionRecords.resumeError,
    })
    .from(decisionRecords)
    .innerJoin(approvals, eq(decisionRecords.approvalId, approvals.id))
    .innerJoin(projects, eq(approvals.projectId, projects.id))
    .leftJoin(users, eq(decisionRecords.actorUserId, users.id))
    .where(and(...filters))
    .orderBy(direction(sortColumn))
    .limit(200)
  return rows.map(toAuditRow)
  })
}

/** Allowlisted audit-row fields. Never decision JSON, origin resume JSON, envelope, or origin. */
export const AUDIT_LIST_KEYS = [
  'id',
  'decision',
  'createdAt',
  'approvalId',
  'actionName',
  'projectId',
  'projectName',
  'actorName',
  'actorEmail',
  'resumeError',
] as const

export type AuditListItem = {
  id: string
  decision: string
  createdAt: Date
  approvalId: string
  actionName: string
  projectId: string
  projectName: string
  actorName: string | null
  actorEmail: string | null
  resumeError: string | null
}

export function toAuditRow(row: AuditListItem): AuditListItem {
  return {
    id: row.id,
    decision: row.decision,
    createdAt: row.createdAt,
    approvalId: row.approvalId,
    actionName: row.actionName,
    projectId: row.projectId,
    projectName: row.projectName,
    actorName: row.actorName,
    actorEmail: row.actorEmail,
    resumeError: row.resumeError,
  }
}

export function serializeAuditList(rows: AuditListItem[]): string {
  return JSON.stringify(rows)
}
