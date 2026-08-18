import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm'
import { CLOSED_APPROVAL_STATUSES, isDecision, type WorkspaceRole } from '@hitly/core'
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

export async function listInboxItems(args: {
  workspaceId: string
  userId: string
  workspaceRole: WorkspaceRole
  projectId?: string
  scope?: string
  q?: string
}) {
  return withTenant(args.workspaceId, async () => {
    const visibleIds = await listVisibleProjectIds(args)
    const projectIds = args.projectId ? visibleIds.filter((id) => id === args.projectId) : visibleIds
    if (projectIds.length === 0) return []
    const database = requireDb()
    const filters = [eq(approvals.workspaceId, args.workspaceId), inArray(approvals.projectId, projectIds)]
  const scope = isInboxScope(args.scope) ? args.scope : 'all'
  if (scope === 'open') {
    filters.push(inArray(approvals.status, ['pending', 'failed_resume']))
  } else if (scope === 'closed') {
    filters.push(inArray(approvals.status, [...CLOSED_APPROVAL_STATUSES]))
  }
  const term = args.q ? likeTerm(args.q) : null
  if (term) {
    const search = or(ilike(approvals.actionName, term), ilike(projects.name, term))
    if (search) filters.push(search)
  }
  return database
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
    .orderBy(desc(approvals.createdAt))
    .limit(100)
  })
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
    .where(and(inArray(approvals.projectId, projectIds), eq(approvals.workspaceId, args.workspaceId), eq(approvals.status, 'pending')))
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
  return database
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
  })
}
