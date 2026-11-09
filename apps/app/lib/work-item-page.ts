import { and, desc, eq } from 'drizzle-orm'
import {
  isOpenApprovalStatus,
  mustOpenItems,
  resolveReasonRequired,
  type AllowedActions,
  type ApprovalEnvelope,
  type EditReasonConfig,
  type EditableFieldSpec,
  type OriginRef,
  type PluginId,
  type WorkspaceRole,
} from '@hitly/core'
import { approvals, decisionRecords, projectMemberships, users } from '@hitly/db/schema'
import { editedArgsFromPayload, omitEditedArgs } from './edited-args'
import { approvalHasExpired } from './approval-expiry'
import { loadOpenedContextRefs } from './context-opens'
import { loadEvidenceReceiptForDisplay } from './evidence'
import { canDecide, getProjectAccess } from './rbac'
import { redactApprovalForReviewer, type OriginField } from './reviewer-approval'
import { requireDb, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'

export type WorkItemPerson = {
  userId: string
  name: string | null
  email: string
  role: string
}

export type WorkItemDecisionView = {
  id: string
  decision: string
  payload: unknown
  resumeError: string | null
  resumeResponse: unknown
  actorUserId: string | null
  createdAt: Date
}

export type WorkItemPageDto = {
  id: string
  status: string
  actionName: string
  plugin: PluginId
  projectId: string
  assignedUserId: string | null
  envelope: ApprovalEnvelope
  origin: OriginRef
  originFields: OriginField[]
  originalArgs: Record<string, unknown>
  jsonDisclosure: unknown
  decisions: WorkItemDecisionView[]
  latestDecision: WorkItemDecisionView | undefined
  editedArgs: Record<string, unknown> | null
  originResponseJson: unknown
  canAct: boolean
  canCancel: boolean
  canRetry: boolean
  expired: boolean
  canDelegate: boolean
  allowed: AllowedActions
  showEditControl: boolean
  editableFields: Record<string, EditableFieldSpec> | undefined
  editReasonConfig: EditReasonConfig | undefined
  respondAllowed: boolean
  reasonRequired: string[]
  gateItems: Array<{ ref: string; label: string; url?: string; opened: boolean }>
  project: {
    id: string
    name: string
    plugin: PluginId
    description: string | null
    defaultSlaMinutes: string
  }
  assigned: { id: string; name: string | null; email: string } | undefined
  defaultAssignee: WorkItemPerson | undefined
  people: WorkItemPerson[]
  delegateTargets: WorkItemPerson[]
  evidenceStoreUri: string | undefined
  returnTo: string
}

/** Props that cross the RSC server/client boundary from the work-item page. */
export function workItemClientFlightProps(page: WorkItemPageDto) {
  return {
    approvalId: page.id,
    originalArgs: page.originalArgs,
    editableFields: page.editableFields,
    editReasonConfig: page.editReasonConfig,
    allowed: { ...page.allowed, edit: page.showEditControl },
    respondAllowed: page.respondAllowed,
    reasonRequired: page.reasonRequired,
    gateItems: page.gateItems,
    contextMarkdown: page.envelope.contextMarkdown,
    externalUrls: page.envelope.externalUrls,
    attachments: page.envelope.attachments,
    canAct: page.canAct,
    editedArgs: page.editedArgs,
    returnTo: page.returnTo,
  }
}

/**
 * Serialised inbox-detail payload: redacted DTO + client flight props + the
 * HTML surfaces (Origin, args, full JSON, origin response). Grep this string
 * for canaries; dropping redactApprovalForReviewer in loadWorkItemPage must go red.
 */
export function serializeWorkItemPage(page: WorkItemPageDto): string {
  return JSON.stringify({
    dto: page,
    clientFlight: workItemClientFlightProps(page),
    originHtml: page.originFields.map((row) => `<dt>${row.label}</dt><dd>${row.value}</dd>`).join(''),
    argsHtml: JSON.stringify(page.originalArgs, null, 2),
    disclosureHtml: JSON.stringify(page.jsonDisclosure, null, 2),
    decisionHtml: page.originResponseJson == null ? '' : JSON.stringify(page.originResponseJson, null, 2),
  })
}

function asArgs(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Server loader for /inbox/:id and /projects/:id/item/:itemId.
 * Returns only a redacted reviewer DTO — never the raw approval row.
 */
export async function loadWorkItemPage(args: {
  approvalId: string
  projectId?: string
  userId: string
  workspaceId: string
  workspaceRole: WorkspaceRole
}): Promise<{ ok: false } | ({ ok: true } & WorkItemPageDto)> {
  return withTenant(args.workspaceId, async () => {
    const database = requireDb()
    const rows = await database
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, args.approvalId), eq(approvals.workspaceId, args.workspaceId)))
      .limit(1)
    const approvalRow = rows[0]
    if (!approvalRow) return { ok: false as const }
    if (args.projectId && approvalRow.projectId !== args.projectId) return { ok: false as const }

    const access = await getProjectAccess({
      projectId: approvalRow.projectId,
      userId: args.userId,
      workspaceRole: args.workspaceRole,
    })
    if (!access) return { ok: false as const }

    const envelope = (await decodeTenantJson(args.workspaceId, approvalRow.envelope)) as unknown as ApprovalEnvelope
    const origin = (await decodeTenantJson(args.workspaceId, approvalRow.origin)) as unknown as OriginRef

    const people = await database
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: projectMemberships.role,
      })
      .from(projectMemberships)
      .innerJoin(users, eq(projectMemberships.userId, users.id))
      .where(
        and(eq(projectMemberships.projectId, approvalRow.projectId), eq(projectMemberships.workspaceId, args.workspaceId)),
      )

    const assignedRows = approvalRow.assignedUserId
      ? await database
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, approvalRow.assignedUserId))
          .limit(1)
      : []
    const assigned = assignedRows[0]
    const defaultAssignee = people.find((person) => person.userId === access.project.defaultAssigneeUserId)

    const decisionRows = await database
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
      .where(and(eq(decisionRecords.approvalId, approvalRow.id), eq(decisionRecords.workspaceId, args.workspaceId)))
      .orderBy(desc(decisionRecords.createdAt))

    const decodedDecisions = await Promise.all(
      decisionRows.map(async (row) => ({
        ...row,
        payload: await decodeTenantJson(args.workspaceId, row.payload),
        resumeResponse: row.resumeResponse
          ? await decodeTenantJson(args.workspaceId, row.resumeResponse)
          : row.resumeResponse,
      })),
    )

    const redacted = redactApprovalForReviewer({ envelope, origin, decisions: decodedDecisions })
    const latestDecision = redacted.decisions[0]
    const editedArgs = latestDecision ? editedArgsFromPayload(latestDecision.payload) : null
    const originalArgs = asArgs(redacted.envelope.action?.args)
    const jsonDisclosure = {
      action: redacted.envelope.action,
      allowedActions: redacted.envelope.allowedActions,
      contextMarkdown: redacted.envelope.contextMarkdown,
      reasonRequired: redacted.envelope.reasonRequired,
      metadata: redacted.envelope.metadata,
      externalUrls: redacted.envelope.externalUrls,
      attachments: redacted.envelope.attachments,
      resumeSchema: redacted.envelope.resumeSchema,
      expiresAt: redacted.envelope.expiresAt,
      origin: redacted.origin,
      _meta: (redacted.envelope as ApprovalEnvelope & { _meta?: unknown })._meta,
    }

    const evidenceReceipt = await loadEvidenceReceiptForDisplay(approvalRow.id, args.workspaceId)
    const evidenceStoreUri =
      evidenceReceipt &&
      (evidenceReceipt.storeUri.startsWith('http://') || evidenceReceipt.storeUri.startsWith('https://'))
        ? evidenceReceipt.storeUri
        : undefined

    const allowed = redacted.envelope.allowedActions
    const hasEditableFields = Boolean(
      redacted.envelope.editableFields && Object.keys(redacted.envelope.editableFields).length > 0,
    )
    const showEditControl = Boolean(allowed.edit && hasEditableFields)
    const canAct = canDecide(access) && isOpenApprovalStatus(approvalRow.status)
    const expired = approvalHasExpired(approvalRow)
    const reasonRequired = resolveReasonRequired(redacted.envelope)
    const gatedItems = canAct && !expired ? mustOpenItems(redacted.envelope) : []
    const openedRefs =
      gatedItems.length > 0
        ? await loadOpenedContextRefs({
            approvalId: approvalRow.id,
            workspaceId: args.workspaceId,
            actorUserId: args.userId,
          })
        : []
    const gateItems = gatedItems.map((item) => ({
      ref: item.ref,
      label: item.label,
      url: item.url,
      opened: openedRefs.includes(item.ref),
    }))
    const canCancel = canDecide(access) && isOpenApprovalStatus(approvalRow.status)
    const delegateTargets = people.filter(
      (person) => person.role !== 'reader' && person.userId !== approvalRow.assignedUserId,
    )
    const canDelegate = canAct && !expired && people.length > 1 && delegateTargets.length > 0
    const inProject = Boolean(args.projectId)
    const returnTo = inProject
      ? `/projects/${approvalRow.projectId}/item/${approvalRow.id}`
      : `/inbox/${approvalRow.id}`

    const project = access.project
    return {
      ok: true as const,
      id: approvalRow.id,
      status: approvalRow.status,
      actionName: approvalRow.actionName,
      plugin: approvalRow.plugin as PluginId,
      projectId: approvalRow.projectId,
      assignedUserId: approvalRow.assignedUserId,
      envelope: redacted.envelope,
      origin: redacted.origin,
      originFields: redacted.originFields,
      originalArgs,
      jsonDisclosure,
      decisions: redacted.decisions,
      latestDecision,
      editedArgs,
      originResponseJson: latestDecision
        ? (latestDecision.resumeResponse ?? omitEditedArgs(latestDecision.payload))
        : undefined,
      canAct,
      canCancel,
      canRetry: approvalRow.status === 'failed_resume' && Boolean(canDecide(access)),
      expired,
      canDelegate,
      allowed,
      showEditControl,
      editableFields: showEditControl ? redacted.envelope.editableFields : undefined,
      editReasonConfig: redacted.envelope.editReason,
      respondAllowed: allowed.respond,
      reasonRequired,
      gateItems,
      project: {
        id: project.id,
        name: project.name,
        plugin: project.plugin as PluginId,
        description: project.description,
        defaultSlaMinutes: project.defaultSlaMinutes,
      },
      assigned,
      defaultAssignee,
      people,
      delegateTargets,
      evidenceStoreUri,
      returnTo,
    }
  })
}
