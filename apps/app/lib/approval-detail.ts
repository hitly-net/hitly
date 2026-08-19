import { desc, eq, and } from 'drizzle-orm'
import { isOpenApprovalStatus, type ApprovalEnvelope, type OriginRef, type PluginId, type WorkspaceRole } from '@hitly/core'
import { approvals, decisionRecords, projects } from '@hitly/db/schema'
import { approvalHasExpired } from './approval-expiry'
import { canDecide, getProjectAccess } from './rbac'
import { originFields, envelopeMetadata } from './origin'
import { requireDb, requireTenantWorkspaceId, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'
import { loadEvidenceReceiptForDisplay } from './evidence'

export async function getApprovalDetail(args: {
  approvalId: string
  userId: string
  workspaceId: string
  workspaceRole: WorkspaceRole
}) {
  return withTenant(args.workspaceId, async () => {
    const database = requireDb()
    const rows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, args.approvalId), eq(approvals.workspaceId, args.workspaceId)))
      .limit(1)
    const approval = rows[0]
    if (!approval) return { ok: false as const, error: 'Not found', status: 404 }

    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: args.userId,
      workspaceRole: args.workspaceRole,
    })
    if (!access) return { ok: false as const, error: 'Not found', status: 404 }

    const envelope = (await decodeTenantJson(args.workspaceId, approval.envelope)) as unknown as ApprovalEnvelope
    const origin = (await decodeTenantJson(args.workspaceId, approval.origin)) as unknown as OriginRef
    const expired = approvalHasExpired(approval)
    const canAct = canDecide(access) && isOpenApprovalStatus(approval.status) && !expired
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
      .where(and(eq(decisionRecords.approvalId, approval.id), eq(decisionRecords.workspaceId, args.workspaceId)))
      .orderBy(desc(decisionRecords.createdAt))

    const decodedDecisions = await Promise.all(
      decisions.map(async (row) => ({
        ...row,
        payload: await decodeTenantJson(args.workspaceId, row.payload),
        resumeResponse: row.resumeResponse
          ? await decodeTenantJson(args.workspaceId, row.resumeResponse)
          : row.resumeResponse,
      })),
    )

    const evidenceReceipt = await loadEvidenceReceiptForDisplay(approval.id, args.workspaceId)
    const evidenceReceiptForApi =
      evidenceReceipt &&
      (evidenceReceipt.storeUri.startsWith('http://') || evidenceReceipt.storeUri.startsWith('https://'))
        ? { storeUri: evidenceReceipt.storeUri }
        : undefined

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
      decisions: decodedDecisions,
      evidenceReceipt: evidenceReceiptForApi,
    }
  })
}

export async function getApprovalProjectName(projectId: string) {
  const database = requireDb()
  const rows = await database
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, requireTenantWorkspaceId())))
    .limit(1)
  return rows[0]?.name ?? null
}
