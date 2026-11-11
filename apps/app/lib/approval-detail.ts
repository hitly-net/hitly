import { desc, eq, and } from 'drizzle-orm'
import { isOpenApprovalStatus, isWorkspaceAdmin, type ApprovalEnvelope, type OriginRef, type PluginId, type WorkspaceRole } from '@hitly/core'
import { approvals, decisionRecords, projects } from '@hitly/db/schema'
import { approvalHasExpired, effectiveApprovalStatus } from './approval-expiry'
import { settleExpiredApproval } from './approvals'
import { canDecide, getProjectAccess } from './rbac'
import { loadOpenedContextRefs } from './context-opens'
import { requireDb, requireTenantWorkspaceId, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'
import { loadEvidenceReceiptForDisplay } from './evidence'
import { redactApprovalForReviewer } from './reviewer-approval'

/** Session GET /api/v1/approvals/:id. Origin, envelope, and decision secrets are redacted in the response only via redactApprovalForReviewer. */
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
    if (access.project.status === 'archived' && !isWorkspaceAdmin(args.workspaceRole)) {
      return { ok: false as const, error: 'Not found', status: 404 }
    }

    const envelope = (await decodeTenantJson(args.workspaceId, approval.envelope)) as unknown as ApprovalEnvelope
    const origin = (await decodeTenantJson(args.workspaceId, approval.origin)) as unknown as OriginRef
    // Read-time expiry (PM ruling): a past-deadline pending row reads `expired`
    // on every surface; the flip fires the one expiry callback exactly once.
    await settleExpiredApproval(approval, args.workspaceId)
    const expired = approvalHasExpired(approval)
    const readStatus = effectiveApprovalStatus(approval)
    const archived = access.project.status === 'archived'
    const canAct = canDecide(access) && isOpenApprovalStatus(approval.status) && !expired && !archived
    const canCancel = canDecide(access) && isOpenApprovalStatus(approval.status) && !expired && !archived

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
    // Response-only: stored envelope/origin/decision JSONB is not rewritten.
    const redacted = redactApprovalForReviewer({ envelope, origin, decisions: decodedDecisions })

    const evidenceReceipt = await loadEvidenceReceiptForDisplay(approval.id, args.workspaceId)
    const evidenceReceiptForApi =
      evidenceReceipt &&
      (evidenceReceipt.storeUri.startsWith('http://') || evidenceReceipt.storeUri.startsWith('https://'))
        ? { storeUri: evidenceReceipt.storeUri }
        : undefined

    // hitly#96 S10: this reviewer's recorded opens, so reviewer clients can hydrate
    // the mustOpen checklist instead of forcing every item to be opened again.
    const openedRefs = canAct
      ? await loadOpenedContextRefs({
          approvalId: approval.id,
          workspaceId: args.workspaceId,
          actorUserId: args.userId,
        })
      : undefined

    return {
      ok: true as const,
      id: approval.id,
      status: readStatus,
      actionName: approval.actionName,
      plugin: approval.plugin as PluginId,
      projectId: approval.projectId,
      projectName: access.project.name,
      assignedUserId: approval.assignedUserId,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      // hitl-spec 4.3: null when the request was never shown to a reviewer.
      presentedAt: approval.presentedAt ? approval.presentedAt.toISOString() : null,
      envelope: redacted.envelope,
      origin: redacted.origin,
      originFields: redacted.originFields,
      canAct,
      canCancel,
      ...(openedRefs ? { openedRefs } : {}),
      decisions: redacted.decisions,
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
