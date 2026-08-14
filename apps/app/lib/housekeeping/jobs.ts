import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { edition } from '@hitly/cloud'
import { CLOSED_APPROVAL_STATUSES } from '@hitly/core'
import { approvals, projectEvents, projects, workspaces } from '@hitly/db/schema'
import { requireDb } from '../require-db'
import { affectedRows } from './result'
import { registerHousekeepingJob } from './scheduler'

const DELETE_CHUNK = 200

export async function expireOverdueApprovals() {
  const database = requireDb()
  const now = new Date()
  const result = await database
    .update(approvals)
    .set({ status: 'expired' })
    .where(and(eq(approvals.status, 'pending'), isNotNull(approvals.expiresAt), lt(approvals.expiresAt, now)))
  return { expired: affectedRows(result) }
}

export async function purgeCompletedApprovals() {
  const database = requireDb()
  const spaces = await database.select({ id: workspaces.id, plan: workspaces.plan }).from(workspaces)
  let deleted = 0
  const byPlan: Record<string, number> = {}

  for (const space of spaces) {
    const days = edition.entitlementsFor(space).completedRetentionDays
    if (days == null) continue
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    let removed = 0
    for (;;) {
      const stale = await database
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.workspaceId, space.id),
            inArray(approvals.status, [...CLOSED_APPROVAL_STATUSES]),
            lt(approvals.updatedAt, cutoff),
          ),
        )
        .limit(DELETE_CHUNK)
      if (stale.length === 0) break
      const ids = stale.map((row) => row.id)
      await database.delete(projectEvents).where(inArray(projectEvents.approvalId, ids))
      await database.delete(approvals).where(inArray(approvals.id, ids))
      removed += ids.length
    }
    deleted += removed
    if (removed > 0) byPlan[space.plan] = (byPlan[space.plan] ?? 0) + removed
  }

  return { deleted, byPlan }
}

export async function purgeExpiredAuditEvents() {
  const database = requireDb()
  const spaces = await database.select({ id: workspaces.id, plan: workspaces.plan }).from(workspaces)
  let deleted = 0

  for (const space of spaces) {
    const days = edition.entitlementsFor(space).auditRetentionDays
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const projectIds = await database
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, space.id))
    if (projectIds.length === 0) continue
    const result = await database
      .delete(projectEvents)
      .where(
        and(
          inArray(
            projectEvents.projectId,
            projectIds.map((row) => row.id),
          ),
          lt(projectEvents.createdAt, cutoff),
        ),
      )
    deleted += affectedRows(result)
  }

  return { deleted }
}

export function registerDefaultHousekeepingJobs() {
  registerHousekeepingJob({
    id: 'expire-overdue-approvals',
    schedule: 'hourly',
    run: expireOverdueApprovals,
  })
  registerHousekeepingJob({
    id: 'purge-completed-approvals',
    schedule: 'daily',
    run: purgeCompletedApprovals,
  })
  registerHousekeepingJob({
    id: 'purge-expired-audit-events',
    schedule: 'weekly',
    run: purgeExpiredAuditEvents,
  })
}
