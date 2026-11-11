import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { edition } from '@hitly/cloud'
import { CLOSED_APPROVAL_STATUSES } from '@hitly/core'
import { approvals, projectEvents, projects, workspaces } from '@hitly/db/schema'
import { requireDb, withTenant } from '../tenant'
import { deliverApprovalLifecycleEvent } from '../lifecycle-delivery'
import { affectedRows } from './result'
import { registerHousekeepingJob } from './scheduler'

const DELETE_CHUNK = 200

/** Row shape the expiry sweep carries from its SELECT to the callback step. */
export type ExpireSweepRow = {
  id: string
  projectId: string
  plugin: string
  origin: Record<string, unknown>
}

export type ExpireSweepOptions = {
  /**
   * Test-only seam: awaited between the sweep's SELECT and its guarded flip,
   * so a test can settle rows through another surface inside the race window
   * or hold the sweep there (hitly#136 M2). Never set outside tests.
   */
  afterSelect?: (spaceId: string, rows: ExpireSweepRow[]) => Promise<void> | void
}

export async function expireOverdueApprovals(options?: ExpireSweepOptions) {
  const database = requireDb()
  const now = new Date()
  const spaces = await database.select({ id: workspaces.id }).from(workspaces)
  let expired = 0
  for (const space of spaces) {
    expired += await withTenant(space.id, async () => {
      const tenantDb = requireDb()
      // Load the rows first: an opted-in HTTP request wants an `expired`
      // lifecycle callback per approval (item 6), which needs its origin.
      const rows = await tenantDb
        .select({ id: approvals.id, projectId: approvals.projectId, plugin: approvals.plugin, origin: approvals.origin })
        .from(approvals)
        .where(
          and(
            eq(approvals.workspaceId, space.id),
            eq(approvals.status, 'pending'),
            isNotNull(approvals.expiresAt),
            lt(approvals.expiresAt, now),
          ),
        )
      if (rows.length === 0) return 0
      await options?.afterSelect?.(space.id, rows)
      // Guarded flip limited to the SELECTed ids, returning the rows this
      // sweep actually won: a row a concurrent read-path settle already
      // flipped matches nothing here, and a row that only became overdue
      // after the SELECT is left for the next sweep (never flipped without
      // its callback). The `expired` callback goes ONLY to flip winners
      // (same guarded-UPDATE winner rule as settleExpiredApproval) -
      // delivering it for every SELECTed row double-fired it whenever a
      // read settled in between.
      const flipped = await tenantDb
        .update(approvals)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            eq(approvals.workspaceId, space.id),
            eq(approvals.status, 'pending'),
            isNotNull(approvals.expiresAt),
            lt(approvals.expiresAt, now),
            inArray(
              approvals.id,
              rows.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: approvals.id })
      const won = new Set(flipped.map((row) => row.id))
      for (const row of rows) {
        if (!won.has(row.id)) continue
        // Best-effort, per item: no-op unless the request opted in.
        await deliverApprovalLifecycleEvent({
          approval: { id: row.id, projectId: row.projectId, plugin: row.plugin, origin: row.origin },
          workspaceId: space.id,
          type: 'expired',
        })
      }
      return flipped.length
    })
  }
  return { expired }
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
    await withTenant(space.id, async () => {
      const tenantDb = requireDb()
      for (;;) {
        const stale = await tenantDb
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
        await tenantDb
          .delete(projectEvents)
          .where(and(eq(projectEvents.workspaceId, space.id), inArray(projectEvents.approvalId, ids)))
        await tenantDb.delete(approvals).where(and(eq(approvals.workspaceId, space.id), inArray(approvals.id, ids)))
        removed += ids.length
      }
    })
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
    deleted += await withTenant(space.id, async () => {
      const tenantDb = requireDb()
      const projectIds = await tenantDb
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.workspaceId, space.id))
      if (projectIds.length === 0) return 0
      const result = await tenantDb.delete(projectEvents).where(
        and(
          eq(projectEvents.workspaceId, space.id),
          inArray(
            projectEvents.projectId,
            projectIds.map((row) => row.id),
          ),
          lt(projectEvents.createdAt, cutoff),
        ),
      )
      return affectedRows(result)
    })
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
