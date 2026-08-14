import { desc, eq } from 'drizzle-orm'
import { isOpenApprovalStatus, type ApprovalEnvelope, type OriginRef, type PluginId, type WorkspaceRole } from '@hitly/core'
import { approvals, decisionRecords, projects } from '@hitly/db/schema'
import { approvalHasExpired } from './approval-expiry'
import { canDecide, getProjectAccess } from './rbac'
import { originFields, envelopeMetadata } from './origin'
import { requireDb } from './require-db'

export async function getApprovalDetail(args: {
  approvalId: string
  userId: string
  workspaceId: string
  workspaceRole: WorkspaceRole
}) {
  const database = requireDb()
  const rows = await database.select().from(approvals).where(eq(approvals.id, args.approvalId)).limit(1)
  const approval = rows[0]
  if (!approval || approval.workspaceId !== args.workspaceId) return { ok: false as const, error: 'Not found', status: 404 }

  const access = await getProjectAccess({
    projectId: approval.projectId,
    userId: args.userId,
    workspaceRole: args.workspaceRole,
  })
  if (!access) return { ok: false as const, error: 'Not found', status: 404 }

  const envelope = approval.envelope as unknown as ApprovalEnvelope
  const origin = approval.origin as unknown as OriginRef
  const expired = approvalHasExpired(approval)
  const canAct =
    canDecide(access) && isOpenApprovalStatus(approval.status) && !expired
  const canCancel = canDecide(access) && isOpenApprovalStatus(approval.status)

  const decisions = await database
    .select({
      id: decisionRecords.id,
      decision: decisionRecords.decision,
      payload: decisionRecords.payload,
      resumeError: decisionRecords.resumeError,
      resumeResponse: decisionRecords.resumeResponse,
      actorUserId: decisionRecords.actorUserId,
      createdAt: decisionRecords.createdAt,
    })
    .from(decisionRecords)
    .where(eq(decisionRecords.approvalId, approval.id))
    .orderBy(desc(decisionRecords.createdAt))

  return {
    ok: true as const,
    id: approval.id,
    status: approval.status,
    actionName: approval.actionName,
    plugin: approval.plugin as PluginId,
    projectId: approval.projectId,
    projectName: access.project.name,
    assignedUserId: approval.assignedUserId,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    envelope: {
      ...envelope,
      metadata: envelopeMetadata(envelope, origin),
    },
    origin,
    originFields: originFields(origin),
    canAct,
    canCancel,
    decisions,
  }
}

export async function getApprovalProjectName(projectId: string) {
  const database = requireDb()
  const rows = await database.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1)
  return rows[0]?.name ?? null
}
