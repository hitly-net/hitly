import { and, asc, desc, eq, gt, gte, inArray, or, sql } from 'drizzle-orm'
import { edition } from '@hitly/cloud'
import {
  isDecision,
  isOpenApprovalStatus,
  isPluginId,
  OPEN_APPROVAL_STATUSES,
  originResumeError,
  validateAnswerSubmission,
  validateRequestGating,
  type ApprovalEnvelope,
  type ChannelType,
  type Decision,
  type DecisionPayload,
  type EditableFieldSpec,
  type EditReasonConfig,
  type EvidenceActor,
  type EvidenceClient,
  type OriginRef,
  type ResumeResponse,
  type WorkspaceRole,
} from '@hitly/core'
import { approvals, decisionRecords, projectApiKeys, projectEvents, projectRules, projects, users } from '@hitly/db/schema'
import { getPlugin } from './plugins'
import { envelopeMetadata } from './origin'
import { hashApiKey } from './keys'
import { logProjectEvent } from './events'
import { notifyAssignee } from './notify'
import { parseRuleActions, parseRuleMatch, ruleMatches } from './rules'
import { ensureProjectResumeSecret } from './resume-secret'
import { newId } from './ids'
import { requireDb, requireTenantWorkspaceId, withTenant } from './tenant'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'
import { approvalHasExpired } from './approval-expiry'
import { appendEvidence, buildDecidedEvent, buildPresentedEvent, buildRequestedEvent, buildResumedEvent, loadLatestReceipt } from './evidence'
import { canDecide, getProjectAccess } from './rbac'
import { loadOpenedContextRefs } from './context-opens'
import { exportOtelTrace } from './otel-trace'
import { resumeFailureMessage } from './resume-error'
import { createOnceCutoff } from './create-once'
import { buildHitlRead } from './hitl-response'

export async function authenticateProjectKey(rawKey: string, projectId?: string) {
  const hashed = hashApiKey(rawKey)
  if (edition.resolveProjectApiKey) {
    const resolved = await edition.resolveProjectApiKey(hashed)
    if (!resolved) return null
    if (projectId && resolved.key.projectId !== projectId) return null
    return resolved
  }

  const database = requireDb()
  const keyRows = await database.select().from(projectApiKeys).where(eq(projectApiKeys.hashedKey, hashed)).limit(1)
  const key = keyRows[0]
  if (!key) return null
  if (projectId && key.projectId !== projectId) return null
  const projectRows = await database.select().from(projects).where(eq(projects.id, key.projectId)).limit(1)
  const project = projectRows[0]
  if (!project) return null
  return { key, project }
}

async function touchApiKey(keyId: string) {
  const workspaceId = requireTenantWorkspaceId()
  await requireDb()
    .update(projectApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(projectApiKeys.id, keyId), eq(projectApiKeys.workspaceId, workspaceId)))
}

async function decodeProject<T extends { workspaceId: string; credentials: Record<string, unknown> }>(project: T) {
  return {
    ...project,
    credentials: await decodeTenantJson(project.workspaceId, project.credentials),
  }
}

async function loadApproval(approvalId: string, workspaceId: string, options?: { forUpdate?: boolean }) {
  const database = requireDb()
  const filters = and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspaceId))
  const rows = options?.forUpdate
    ? await database.select().from(approvals).where(filters).for('update').limit(1)
    : await database.select().from(approvals).where(filters).limit(1)
  const approval = rows[0]
  if (!approval) return null
  return {
    ...approval,
    envelope: await decodeTenantJson(workspaceId, approval.envelope),
    origin: await decodeTenantJson(workspaceId, approval.origin),
  }
}

function asEnvelope(value: Record<string, unknown>): ApprovalEnvelope {
  return value as unknown as ApprovalEnvelope
}

function asOrigin(value: Record<string, unknown>): OriginRef {
  return value as unknown as OriginRef
}

/**
 * Q2 (PR decision): include the person's display name in `decidedBy`/`presented`
 * actors for external evidence sinks. Flip to false for id-only actors (no PII
 * in sinks). Single constant so it is a one-line change.
 */
export const EVIDENCE_INCLUDE_ACTOR_DISPLAY = true

/** Resolve the deciding human into the hitl-spec `{kind,id,display?}` actor shape (spec 4.1/4.2). */
async function resolveReviewerActor(database: ReturnType<typeof requireDb>, actorUserId: string): Promise<EvidenceActor> {
  let display: string | undefined
  if (EVIDENCE_INCLUDE_ACTOR_DISPLAY && actorUserId) {
    const rows = await database
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1)
    const person = rows[0]
    display = person?.name || person?.email || undefined
  }
  return { kind: 'human', id: actorUserId, ...(display ? { display } : {}) }
}

/**
 * B1 guard (hitly#97): a `presented` record may only be written for an ask that
 * has NOT been decided yet. Migration 0004 added `presented_at` as NULL with no
 * backfill, so pre-migration rows can legitimately be `failed_resume` (an open
 * status) with `presented_at IS NULL`. Appending `presented` for those rows
 * would place it AFTER `decided` in the evidence chain, which is false evidence
 * (an item that was decided was necessarily already shown) and breaks the
 * hitl-spec 5.2/5.4 order requested -> presented -> decided -> resumed.
 *
 * Returns true when the row is still `pending`, or - belt and braces for odd
 * states - when no decision has ever been recorded for it.
 */
async function mayRecordPresented(
  database: ReturnType<typeof requireDb>,
  approvalId: string,
  status: string,
  workspaceId: string,
): Promise<boolean> {
  if (status === 'pending') return true
  const decidedRows = await database
    .select({ id: decisionRecords.id })
    .from(decisionRecords)
    .where(and(eq(decisionRecords.approvalId, approvalId), eq(decisionRecords.workspaceId, workspaceId)))
    .limit(1)
  return decidedRows.length === 0
}

/**
 * Record that an ask was FIRST shown to a reviewer who can decide (hitl-spec 5.2,
 * sets `activity.presentedAt`, spec 4.3).
 *
 * - Runs inside the tenant transaction with a row lock (`forUpdate`) so it
 *   serialises with `decideApproval` and the receipt `seq` cannot fork.
 * - Idempotent: first writer wins; later calls are no-ops.
 * - Readers browsing the item are not reviewers: users who cannot decide do not
 *   mark it presented.
 * - The `presented` evidence append is fail-open (same as `requested`): sink
 *   errors are logged as warnings, never thrown. The `presented` project event
 *   row keeps it visible even when the sink is `none`.
 */
export async function markApprovalPresented(args: {
  approvalId: string
  actorUserId: string
  workspaceRole: WorkspaceRole
  workspaceId?: string
  client?: EvidenceClient
}): Promise<{ presentedAt: string | null } | { error: string; status: 404 }> {
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  return withTenant(workspaceId, async () => {
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, workspaceId, { forUpdate: true })
    if (!approval) return { error: 'Not found', status: 404 as const }
    const access = await getProjectAccess({
      projectId: approval.projectId,
      userId: args.actorUserId,
      workspaceRole: args.workspaceRole,
    })
    if (!access) return { error: 'Not found', status: 404 as const }
    if (!canDecide(access)) return { presentedAt: null }
    if (approval.presentedAt) return { presentedAt: approval.presentedAt.toISOString() }
    if (!isOpenApprovalStatus(approval.status) || approvalHasExpired(approval)) {
      return { presentedAt: null }
    }
    // Legacy rows from before migration 0004 have presented_at NULL even when
    // already decided (failed_resume is an open status). A late `presented`
    // would land after `decided` in the chain: false evidence, never recorded.
    if (!(await mayRecordPresented(database, approval.id, approval.status, workspaceId))) {
      return { presentedAt: null }
    }

    const presentedAt = new Date()
    // Pin updatedAt: "first shown" is audit metadata, not a lifecycle change.
    await database
      .update(approvals)
      .set({
        presentedAt,
        presentedByUserId: args.actorUserId || null,
        updatedAt: approval.updatedAt,
      })
      .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspaceId)))

    await logProjectEvent({
      workspaceId,
      projectId: approval.projectId,
      approvalId: approval.id,
      type: 'presented',
      message: 'First shown to reviewer',
      payload: { actorUserId: args.actorUserId, channel: args.client?.channel ?? null },
    })

    const envelope = asEnvelope(approval.envelope)
    const origin = asOrigin(approval.origin)
    try {
      const latest = await loadLatestReceipt(approval.id, workspaceId)
      const actor = await resolveReviewerActor(database, args.actorUserId)
      const presentedEvent = await buildPresentedEvent({
        approvalId: approval.id,
        envelope,
        origin,
        actor,
        client: args.client,
        seq: latest.seq + 1,
        prevEventId: latest.prevEventId,
        prevContentSha256: latest.prevContentSha256,
      })
      await appendEvidence({
        event: presentedEvent,
        projectId: approval.projectId,
        workspaceId,
        evidenceDurable: false,
      })
      exportOtelTrace({ event: presentedEvent, envelope, origin, workspaceId }).catch((error) => {
        console.error('[otel] Export failed (presented):', error)
      })
    } catch (error) {
      await logProjectEvent({
        workspaceId,
        projectId: approval.projectId,
        approvalId: approval.id,
        level: 'warn',
        type: 'evidence',
        message: `Evidence sink append failed (presented): ${error instanceof Error ? error.message : 'unknown'}`,
      })
    }

    return { presentedAt: presentedAt.toISOString() }
  })
}

function withProjectCredentials(body: Record<string, unknown>, project: typeof projects.$inferSelect) {
  const credentials = project.credentials
  const merged: Record<string, unknown> = { ...body, projectId: project.id, plugin: project.plugin }
  if (!merged.mastraBaseUrl && typeof credentials.baseUrl === 'string') {
    merged.mastraBaseUrl = credentials.baseUrl
  }
  if (!merged.deploymentUrl && typeof credentials.deploymentUrl === 'string') {
    merged.deploymentUrl = credentials.deploymentUrl
  }
  if (!merged.address && typeof credentials.address === 'string') {
    merged.address = credentials.address
  }
  return merged
}

async function applyRules(args: {
  project: typeof projects.$inferSelect
  envelope: ApprovalEnvelope
  origin: OriginRef
}) {
  const database = requireDb()
  const rules = await database
    .select()
    .from(projectRules)
    .where(and(eq(projectRules.projectId, args.project.id), eq(projectRules.workspaceId, args.project.workspaceId)))
    .orderBy(asc(projectRules.priority))

  const matched = rules.find((rule) => rule.enabled && ruleMatches(parseRuleMatch(rule.match), args.envelope, args.origin))
  const actions = matched ? parseRuleActions(matched.actions) : {}
  const slaMinutes = actions.slaMinutes ?? Number(args.project.defaultSlaMinutes) ?? 60
  const expiresAt = new Date(Date.now() + Math.max(slaMinutes, 1) * 60_000)
  const envelopeExpiry = args.envelope.expiresAt ? new Date(args.envelope.expiresAt) : null
  const finalExpiry =
    envelopeExpiry && !Number.isNaN(envelopeExpiry.getTime()) && envelopeExpiry.getTime() < expiresAt.getTime()
      ? envelopeExpiry
      : expiresAt
  const channelTypes: ChannelType[] = actions.channelTypes?.length ? actions.channelTypes : ['email']
  return {
    matched,
    expiresAt: finalExpiry,
    channelTypes,
    assignedUserId: args.project.defaultAssigneeUserId,
  }
}

export async function ingestApproval(args: {
  apiKey: string
  body: Record<string, unknown>
  idempotencyKey?: string | null
  /** Clock for the create-once window (tests). */
  now?: number
}) {
  const requestedProjectId = typeof args.body.projectId === 'string' ? args.body.projectId : undefined
  const authn = await authenticateProjectKey(args.apiKey, requestedProjectId)
  if (!authn) {
    return { ok: false as const, error: 'Invalid API key or project', status: 401 as const }
  }

  const { project: rawProject, key } = authn

  return withTenant(rawProject.workspaceId, async () => {
  await touchApiKey(key.id)
  const database = requireDb()
  const projectRows = await database
    .select()
    .from(projects)
    .where(and(eq(projects.id, rawProject.id), eq(projects.workspaceId, rawProject.workspaceId)))
    .limit(1)
  const loaded = projectRows[0]
  if (!loaded) {
    return { ok: false as const, error: 'Invalid API key or project', status: 401 as const }
  }
  const project = await decodeProject(loaded)

  if (args.idempotencyKey) {
    // Create-once (hitl-spec 3.2): serialise submissions of the same key in this
    // project for the rest of the transaction, so two concurrent submits cannot
    // both miss the lookup and create two asks.
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`hitly:create-once:${project.id}:${args.idempotencyKey}`}, 0))`,
    )
    // Replay is scoped to the API key that created the request, consistent
    // with key-scoped cancel and the pending list (PM ruling D3). Open
    // requests replay at any age; closed ones replay inside the published
    // retention window (lib/create-once.ts). The stored request is returned
    // unchanged, whatever the new body says.
    const existing = await database
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, project.workspaceId),
          eq(approvals.projectId, project.id),
          eq(approvals.idempotencyKey, args.idempotencyKey),
          eq(approvals.requesterKeyId, key.id),
          or(inArray(approvals.status, OPEN_APPROVAL_STATUSES), gt(approvals.createdAt, createOnceCutoff(args.now ?? Date.now()))),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1)
    if (existing[0]) {
      await logProjectEvent({
        workspaceId: project.workspaceId,
        projectId: project.id,
        approvalId: existing[0].id,
        type: 'ingest',
        message: 'Create-once replay: returned the existing request',
        payload: { replayed: true, status: existing[0].status, requesterKeyId: key.id },
      })
      return {
        ok: true as const,
        approval: {
          ...existing[0],
          envelope: await decodeTenantJson(project.workspaceId, existing[0].envelope),
          origin: await decodeTenantJson(project.workspaceId, existing[0].origin),
        },
        replayed: true,
      }
    }

    // D3 (PM ruling): replay is per creating key, so a sibling key in the
    // same project never replays another key's request. If the id is still
    // held by a request this key cannot replay - a sibling's, or a legacy
    // key-less row - the submission is a plain conflict: no id, status or
    // payload of the other request is disclosed, and no second ask is
    // created for a live id.
    const heldByOther = await database
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, project.workspaceId),
          eq(approvals.projectId, project.id),
          eq(approvals.idempotencyKey, args.idempotencyKey),
          sql`${approvals.requesterKeyId} is distinct from ${key.id}`,
          or(inArray(approvals.status, OPEN_APPROVAL_STATUSES), gt(approvals.createdAt, createOnceCutoff(args.now ?? Date.now()))),
        ),
      )
      .limit(1)
    if (heldByOther[0]) {
      await logProjectEvent({
        workspaceId: project.workspaceId,
        projectId: project.id,
        type: 'ingest',
        level: 'warn',
        message: 'Create-once conflict: Idempotency-Key is held by a different API key',
        payload: { conflict: true, requesterKeyId: key.id },
      })
      return {
        ok: false as const,
        error: 'Idempotency-Key already used in this project by a different API key',
        status: 409 as const,
      }
    }
  }

  const pluginId = args.body.plugin ?? project.plugin
  if (!isPluginId(pluginId) || pluginId !== project.plugin) {
    await logProjectEvent({
      projectId: project.id,
      level: 'error',
      type: 'ingest',
      message: `Plugin mismatch: expected ${project.plugin}`,
    })
    return { ok: false as const, error: `Project is configured for ${project.plugin}`, status: 400 as const }
  }

  const merged = withProjectCredentials(args.body, project)
  let ingested
  try {
    ingested = getPlugin(pluginId).ingest(merged)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed'
    await logProjectEvent({
      projectId: project.id,
      level: 'error',
      type: 'ingest',
      message,
    })
    return { ok: false as const, error: message, status: 400 as const }
  }

  // Request-level gating validation (hitl-spec 7, at ingest): refuse malformed
  // reasonRequired entries and context refs instead of storing a broken gate.
  const gatingErrors = validateRequestGating(ingested)
  if (gatingErrors.length > 0) {
    const message = `Invalid gating config: ${gatingErrors.map((error) => `${error.field}: ${error.message}`).join('; ')}`
    await logProjectEvent({
      projectId: project.id,
      level: 'error',
      type: 'ingest',
      message,
    })
    return { ok: false as const, error: message, status: 400 as const }
  }

  ingested.origin.projectId = project.id
  if (pluginId === 'mastra' && !ingested.origin.resumeHandle.mastraBaseUrl && typeof project.credentials.baseUrl === 'string') {
    ingested.origin.resumeHandle.mastraBaseUrl = project.credentials.baseUrl
  }

  const routed = await applyRules({ project, envelope: ingested, origin: ingested.origin })
  const approvalId = newId('apr').slice(0, 36)
  await database.insert(approvals).values({
    id: approvalId,
    workspaceId: project.workspaceId,
    projectId: project.id,
    assignedUserId: routed.assignedUserId,
    plugin: pluginId,
    status: 'pending',
    actionName: ingested.action.name,
    envelope: await encodeTenantJson(project.workspaceId, ingested as unknown as Record<string, unknown>),
    origin: await encodeTenantJson(project.workspaceId, ingested.origin as unknown as Record<string, unknown>),
    idempotencyKey: args.idempotencyKey ?? null,
    requesterKeyId: key.id,
    expiresAt: routed.expiresAt,
  })

  await logProjectEvent({
    workspaceId: project.workspaceId,
    projectId: project.id,
    approvalId,
    type: 'ingest',
    message: `Ingested ${ingested.action.name}`,
    payload: {
      plugin: pluginId,
      runId: ingested.origin.runId,
      actionName: ingested.action.name,
    },
  })
  if (routed.matched) {
    await logProjectEvent({
      projectId: project.id,
      approvalId,
      type: 'rule_matched',
      message: `Matched rule ${routed.matched.name}`,
      payload: { ruleId: routed.matched.id },
    })
  }

  await notifyAssignee({
    projectId: project.id,
    approvalId,
    assignedUserId: routed.assignedUserId,
    actionName: ingested.action.name,
    channelTypes: routed.channelTypes,
  })

    try {
      const latest = await loadLatestReceipt(approvalId, project.workspaceId)
      const requestedEvent = await buildRequestedEvent({
        approvalId,
        envelope: ingested,
        origin: ingested.origin,
        seq: latest.seq + 1,
        prevEventId: latest.prevEventId,
        prevContentSha256: latest.prevContentSha256,
      })
      await appendEvidence({
        event: requestedEvent,
        projectId: project.id,
        workspaceId: project.workspaceId,
        evidenceDurable: false,
      })
      exportOtelTrace({
        event: requestedEvent,
        envelope: ingested,
        origin: ingested.origin,
        workspaceId: project.workspaceId,
      }).catch((error) => {
        console.error('[otel] Export failed (requested):', error)
      })
    } catch (error) {
      await logProjectEvent({
        projectId: project.id,
        approvalId,
        level: 'warn',
        type: 'evidence',
        message: `Evidence sink append failed (requested): ${error instanceof Error ? error.message : 'unknown'}`,
      })
    }

  const created = await database
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, project.workspaceId)))
    .limit(1)
  if (!created[0]) {
    return { ok: false as const, error: 'Failed to persist approval', status: 500 as const }
  }
  return {
    ok: true as const,
    approval: {
      ...created[0],
      envelope: await decodeTenantJson(project.workspaceId, created[0].envelope),
      origin: await decodeTenantJson(project.workspaceId, created[0].origin),
    },
    replayed: false,
  }
  })
}

export async function decideApproval(args: {
  approvalId: string
  actorUserId: string
  payload: DecisionPayload
  workspaceId?: string
  /** Reviewer device/channel from the decide request (evidence `client`, spec 5.3). */
  client?: EvidenceClient
  /** Set by retryResume: marks the audit event only, never the evidence oversight. */
  retry?: boolean
}) {
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  return withTenant(workspaceId, async () => {
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, workspaceId, { forUpdate: true })
    if (!approval) return { error: 'Not found', status: 404 as const }
    if (approvalHasExpired(approval)) {
      if (approval.status === 'pending') {
        await database
          .update(approvals)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspaceId)))
      }
      return { error: 'Approval has expired', status: 409 as const }
    }
    if (!isOpenApprovalStatus(approval.status)) {
      return { error: 'Approval is not awaiting a decision', status: 409 as const }
    }

    const envelope = asEnvelope(approval.envelope)
    if (!envelope.allowedActions[args.payload.decision]) {
      return { error: `Decision ${args.payload.decision} is not allowed`, status: 400 as const }
    }

    // Answer gating (hitl-spec 3.6/3.7/7): the host re-validates reasonRequired and
    // mustOpen on every submit, per deciding reviewer, and refuses with field errors.
    // Opens are read from this reviewer's recorded `opened` events (openedAt audit).
    const openedContextRefs = await loadOpenedContextRefs({
      approvalId: approval.id,
      workspaceId,
      actorUserId: args.actorUserId,
    })
    const gatingErrors = validateAnswerSubmission({
      envelope: envelope,
      decision: args.payload.decision,
      reason: args.payload.reason,
      openedRefs: openedContextRefs,
    })
    if (gatingErrors.length > 0) {
      return {
        error: gatingErrors.map((error) => `${error.field}: ${error.message}`).join('; '),
        status: 400 as const,
        fields: gatingErrors,
      }
    }

    // Fail-closed: if edit is allowed but editableFields is missing or empty, reject
    if (args.payload.decision === 'edit') {
      const hasEditableFields = envelope.editableFields && Object.keys(envelope.editableFields).length > 0
      if (!hasEditableFields) {
        return { error: 'Edit decision requires editableFields to be defined', status: 400 as const }
      }

      // Validate edit reason
      const reasonValidation = validateEditReason({
        editReason: args.payload.editReason,
        editReasonText: args.payload.editReasonText,
        editReasonConfig: envelope.editReason,
      })
      if (reasonValidation) {
        return reasonValidation
      }
    }

    // Merge and validate edited args against allowlist
    let mergedArgs = envelope.action.args
    let editedDelta: Record<string, unknown> | undefined
    if (args.payload.decision === 'edit' && args.payload.editedArgs && envelope.editableFields) {
      const mergeResult = mergeEditableArgs({
        originalArgs: envelope.action.args,
        editedArgs: args.payload.editedArgs,
        editableFields: envelope.editableFields,
      })
      if ('error' in mergeResult) {
        return mergeResult
      }
      mergedArgs = mergeResult.mergedArgs
      editedDelta = mergeResult.editedDelta
    }

    const origin = asOrigin(approval.origin)
    const projectRows = await database
      .select()
      .from(projects)
      .where(and(eq(projects.id, approval.projectId), eq(projects.workspaceId, workspaceId)))
      .limit(1)
    const project = projectRows[0] ? await decodeProject(projectRows[0]) : null
    if (project && origin.plugin === 'mastra' && !origin.resumeHandle.mastraBaseUrl) {
      origin.resumeHandle.mastraBaseUrl = project.credentials.baseUrl
    }

    let latest = await loadLatestReceipt(approval.id, workspaceId)
    const reviewerActor = await resolveReviewerActor(database, args.actorUserId)

    // Implicit `presented` on decide (hitl-spec 5.2): an API-only decide, an old
    // mobile build, or a submit that beats the mark-presented effect still records
    // that the ask was shown. Same transaction, same actor/client, BEFORE `decided`
    // in the chain (spec 5.4: presented must precede decided).
    // B1 (hitly#97): never for retries (the row is already decided) and never for
    // legacy rows that carry a decision with presented_at NULL - see
    // `mayRecordPresented`; a `presented` appended there would land after `decided`.
    if (
      !args.retry &&
      !approval.presentedAt &&
      (await mayRecordPresented(database, approval.id, approval.status, workspaceId))
    ) {
      const implicitPresentedAt = new Date()
      await database
        .update(approvals)
        .set({
          presentedAt: implicitPresentedAt,
          presentedByUserId: args.actorUserId || null,
          updatedAt: approval.updatedAt,
        })
        .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspaceId)))
      await logProjectEvent({
        workspaceId,
        projectId: approval.projectId,
        approvalId: approval.id,
        type: 'presented',
        message: 'First shown to reviewer (implicit on decide)',
        payload: { actorUserId: args.actorUserId, channel: args.client?.channel ?? null, implicit: true },
      })
      try {
        const presentedEvent = await buildPresentedEvent({
          approvalId: approval.id,
          envelope,
          origin,
          actor: reviewerActor,
          client: args.client,
          seq: latest.seq + 1,
          prevEventId: latest.prevEventId,
          prevContentSha256: latest.prevContentSha256,
        })
        const presentedReceipt = await appendEvidence({
          event: presentedEvent,
          projectId: approval.projectId,
          workspaceId,
          evidenceDurable: false,
        })
        exportOtelTrace({ event: presentedEvent, envelope, origin, workspaceId }).catch((error) => {
          console.error('[otel] Export failed (presented):', error)
        })
        if (presentedReceipt) {
          // Carry the presented receipt forward so `decided`/`resumed` chain linearly after it.
          latest = {
            seq: presentedEvent.seq,
            prevEventId: presentedEvent.event_id,
            prevContentSha256: presentedEvent.integrity.content_sha256,
          }
        }
      } catch (error) {
        // Fail-open like `requested`: decided still fail-closes on its own append.
        await logProjectEvent({
          workspaceId,
          projectId: approval.projectId,
          approvalId: approval.id,
          level: 'warn',
          type: 'evidence',
          message: `Evidence sink append failed (presented): ${error instanceof Error ? error.message : 'unknown'}`,
        })
      }
    }

    let decidedEventId: string | undefined
    let decidedContentSha256: string | undefined
    try {
      const decidedEvent = await buildDecidedEvent({
        approvalId: approval.id,
        envelope,
        origin,
        payload: {
          ...args.payload,
          editedArgs: editedDelta, // Store only the delta in evidence
        },
        reviewerId: args.actorUserId,
        decidedBy: reviewerActor,
        client: args.client,
        seq: latest.seq + 1,
        prevEventId: latest.prevEventId ?? '',
        prevContentSha256: latest.prevContentSha256 ?? '',
        mergedArgs, // Pass merged args for final_sha256 computation
      })
      decidedEventId = decidedEvent.event_id
      decidedContentSha256 = decidedEvent.integrity.content_sha256
      await appendEvidence({
        event: decidedEvent,
        projectId: approval.projectId,
        workspaceId,
        evidenceDurable: true,
      })
      exportOtelTrace({
        event: decidedEvent,
        envelope,
        origin,
        payload: args.payload,
        workspaceId,
      }).catch((error) => {
        console.error('[otel] Export failed (decided):', error)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Evidence sink append failed'
      await logProjectEvent({
        workspaceId,
        projectId: approval.projectId,
        approvalId: approval.id,
        level: 'error',
        type: 'evidence',
        message: `Evidence sink append failed (decided, fail-closed): ${message}`,
      })
      return {
        error: `Evidence sink append failed (fail-closed): ${message}`,
        status: 500 as const,
      }
    }

    let resumeError: string | null = null
    let resumeResponse: ResumeResponse | null = null
    let status: 'decided' | 'failed_resume' = 'decided'
    if (args.payload.decision !== 'ignore') {
      try {
        const secured = project ? await ensureProjectResumeSecret(project) : null
        const originResponse = await getPlugin(approval.plugin).resume(
          {
            ...origin,
            resumeHandle: {
              ...origin.resumeHandle,
              approvalId: approval.id,
              metadata: envelopeMetadata(envelope, origin),
            },
          },
          {
            ...args.payload,
            editedArgs: mergedArgs !== envelope.action.args ? mergedArgs : undefined, // Send merged args to origin
          },
          secured ? { plugin: approval.plugin, ...secured.project.credentials } : undefined,
        )
        if (originResponse) resumeResponse = originResponse
        const failed = originResumeError(originResponse)
        if (failed) {
          resumeError = failed
          status = 'failed_resume'
        }

        try {
          const resumedEvent = await buildResumedEvent({
            approvalId: approval.id,
            envelope,
            origin,
            seq: latest.seq + 2,
            prevEventId: decidedEventId ?? '',
            prevContentSha256: decidedContentSha256 ?? '',
            success: !failed,
            mergedArgs,
          })
          await appendEvidence({
            event: resumedEvent,
            projectId: approval.projectId,
            workspaceId,
            evidenceDurable: false,
          })
          exportOtelTrace({
            event: resumedEvent,
            envelope,
            origin,
            workspaceId,
          }).catch((error) => {
            console.error('[otel] Export failed (resumed):', error)
          })
        } catch (error) {
          await logProjectEvent({
            workspaceId,
            projectId: approval.projectId,
            approvalId: approval.id,
            level: 'warn',
            type: 'evidence',
            message: `Evidence sink append failed (resumed): ${error instanceof Error ? error.message : 'unknown'}`,
          })
        }
      } catch (error) {
        resumeError = resumeFailureMessage(error)
        status = 'failed_resume'

        try {
          const resumedEvent = await buildResumedEvent({
            approvalId: approval.id,
            envelope,
            origin,
            seq: latest.seq + 2,
            prevEventId: decidedEventId ?? '',
            prevContentSha256: decidedContentSha256 ?? '',
            success: false,
            mergedArgs,
          })
          await appendEvidence({
            event: resumedEvent,
            projectId: approval.projectId,
            workspaceId,
            evidenceDurable: false,
          })
          exportOtelTrace({
            event: resumedEvent,
            envelope,
            origin,
            workspaceId,
          }).catch((error) => {
            console.error('[otel] Export failed (resume_failed):', error)
          })
        } catch (error) {
          await logProjectEvent({
            workspaceId,
            projectId: approval.projectId,
            approvalId: approval.id,
            level: 'warn',
            type: 'evidence',
            message: `Evidence sink append failed (resume_failed): ${error instanceof Error ? error.message : 'unknown'}`,
          })
        }
      }
    }

    await database.insert(decisionRecords).values({
      id: newId('dec').slice(0, 36),
      workspaceId,
      approvalId: approval.id,
      actorUserId: args.actorUserId,
      decision: args.payload.decision,
      payload: await encodeTenantJson(workspaceId, args.payload as unknown as Record<string, unknown>),
      client: args.client
        ? await encodeTenantJson(workspaceId, args.client as unknown as Record<string, unknown>)
        : null,
      resumeError,
      resumeResponse: resumeResponse
        ? await encodeTenantJson(workspaceId, resumeResponse as unknown as Record<string, unknown>)
        : null,
    })
    await database
      .update(approvals)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspaceId)))
    await logProjectEvent({
      workspaceId,
      projectId: approval.projectId,
      approvalId: approval.id,
      level: resumeError ? 'error' : 'info',
      type: resumeError ? 'resume' : 'decided',
      message: resumeError ?? `Decision ${args.payload.decision}`,
      payload: { decision: args.payload.decision, ...(args.retry ? { retry: true } : {}) },
    })

    const updated = await loadApproval(approval.id, workspaceId)
    return { approval: updated ?? approval, resumeError, resumeResponse, status }
  })
}

export async function cancelApproval(args: { approvalId: string; actorUserId: string; workspaceId?: string }) {
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  return withTenant(workspaceId, async () => {
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, workspaceId, { forUpdate: true })
    if (!approval) return { error: 'Not found', status: 404 as const }
    if (!isOpenApprovalStatus(approval.status)) {
      return { error: 'Approval is not open', status: 409 as const }
    }

    await database.insert(decisionRecords).values({
      id: newId('dec').slice(0, 36),
      workspaceId,
      approvalId: approval.id,
      actorUserId: args.actorUserId,
      decision: 'cancel',
      payload: await encodeTenantJson(workspaceId, { decision: 'cancel' }),
      resumeError: null,
      resumeResponse: null,
    })
    await database
      .update(approvals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspaceId)))
    await logProjectEvent({
      workspaceId,
      projectId: approval.projectId,
      approvalId: approval.id,
      type: 'cancelled',
      message: 'Force cancelled without resuming the origin',
      payload: { decision: 'cancel', previousStatus: approval.status },
    })
    const updated = await loadApproval(approval.id, workspaceId)
    return { approval: updated ?? approval, status: 'cancelled' as const }
  })
}

/**
 * Requester cancel with a project API key. Only the key that created the
 * request may cancel it; any other key (including another key on the same
 * project) gets 404, so request ids do not leak across requesters. Recorded
 * as `cancel` with `by: "requester"` and no human actor: it is not a reviewer
 * decline. The origin is not resumed (the requester withdrew it itself).
 */
export async function cancelApprovalAsRequester(args: { apiKey: string; approvalId: string; reason?: string }) {
  const authn = await authenticateProjectKey(args.apiKey)
  if (!authn) return { ok: false as const, error: 'Invalid API key', status: 401 as const }
  const workspaceId = authn.project.workspaceId
  return withTenant(workspaceId, async () => {
    await touchApiKey(authn.key.id)
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, workspaceId, { forUpdate: true })
    if (!approval || approval.projectId !== authn.project.id || approval.requesterKeyId !== authn.key.id) {
      return { ok: false as const, error: 'Not found', status: 404 as const }
    }
    if (approvalHasExpired(approval)) {
      if (approval.status === 'pending') {
        await database
          .update(approvals)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspaceId)))
      }
      return { ok: false as const, error: 'Approval has expired', status: 409 as const }
    }
    if (approval.status !== 'pending') {
      // failed_resume already carries a reviewer decision; only an unanswered ask can be withdrawn.
      return { ok: false as const, error: 'Approval is not awaiting a decision', status: 409 as const }
    }
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 1000) : undefined
    await database.insert(decisionRecords).values({
      id: newId('dec').slice(0, 36),
      workspaceId,
      approvalId: approval.id,
      actorUserId: null,
      decision: 'cancel',
      payload: await encodeTenantJson(workspaceId, {
        decision: 'cancel',
        by: 'requester',
        requesterKeyId: authn.key.id,
        ...(reason ? { reason } : {}),
      }),
      resumeError: null,
      resumeResponse: null,
    })
    await database
      .update(approvals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(approvals.id, approval.id), eq(approvals.workspaceId, workspaceId)))
    await logProjectEvent({
      workspaceId,
      projectId: approval.projectId,
      approvalId: approval.id,
      type: 'cancelled',
      message: `Cancelled by the requester (API key ${authn.key.prefix}…)`,
      payload: { decision: 'cancel', by: 'requester', requesterKeyId: authn.key.id, previousStatus: approval.status },
    })
    return { ok: true as const, id: approval.id, status: 'cancelled' as const }
  })
}

export const REQUESTER_PENDING_DEFAULT_LIMIT = 50
export const REQUESTER_PENDING_MAX_LIMIT = 200

/**
 * The requester's open requests: created by this API key, in its project,
 * still `pending` (and not past their deadline) or `failed_resume`. Newest first.
 */
export async function listRequesterPending(args: { apiKey: string; projectId?: string; limit?: number }) {
  const authn = await authenticateProjectKey(args.apiKey, args.projectId)
  if (!authn) return { ok: false as const, error: 'Invalid API key or project', status: 401 as const }
  const workspaceId = authn.project.workspaceId
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? REQUESTER_PENDING_DEFAULT_LIMIT), 1), REQUESTER_PENDING_MAX_LIMIT)
  return withTenant(workspaceId, async () => {
    await touchApiKey(authn.key.id)
    const now = new Date()
    const rows = await requireDb()
      .select({
        id: approvals.id,
        status: approvals.status,
        actionName: approvals.actionName,
        idempotencyKey: approvals.idempotencyKey,
        createdAt: approvals.createdAt,
        expiresAt: approvals.expiresAt,
        presentedAt: approvals.presentedAt,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, workspaceId),
          eq(approvals.projectId, authn.project.id),
          eq(approvals.requesterKeyId, authn.key.id),
          or(
            eq(approvals.status, 'failed_resume'),
            and(eq(approvals.status, 'pending'), or(sql`${approvals.expiresAt} is null`, gte(approvals.expiresAt, now))),
          ),
        ),
      )
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(limit)
    return {
      ok: true as const,
      projectId: authn.project.id,
      items: rows.map((row) => ({
        id: row.id,
        kind: 'approval' as const,
        status: row.status,
        actionName: row.actionName,
        idempotencyKey: row.idempotencyKey,
        createdAt: row.createdAt.toISOString(),
        deadline: row.expiresAt ? row.expiresAt.toISOString() : null,
        presentedAt: row.presentedAt ? row.presentedAt.toISOString() : null,
      })),
    }
  })
}

export async function retryResume(args: { approvalId: string; workspaceId?: string }) {
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  return withTenant(workspaceId, async () => {
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, workspaceId)
    if (!approval) return { error: 'Not found', status: 404 as const }
    if (approval.status !== 'failed_resume') {
      return { error: 'Approval is not in failed_resume', status: 409 as const }
    }
    const decisionRows = await database
      .select()
      .from(decisionRecords)
      .where(and(eq(decisionRecords.approvalId, approval.id), eq(decisionRecords.workspaceId, workspaceId)))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(1)
    const record = decisionRows[0]
    if (!record || !isDecision(record.decision)) {
      return { error: 'No decision to retry', status: 409 as const }
    }
    const payload = (await decodeTenantJson(workspaceId, record.payload)) as unknown as DecisionPayload
    // A retry must not relabel the original decider's device: reuse the STORED
    // client and actor. The retry itself is marked in the project event only
    // (payload.retry), never in oversight.client.
    const storedClient = record.client
      ? ((await decodeTenantJson(workspaceId, record.client)) as unknown as EvidenceClient)
      : undefined
    return decideApproval({
      approvalId: approval.id,
      actorUserId: record.actorUserId ?? '',
      payload,
      workspaceId,
      client: storedClient,
      retry: true,
    })
  })
}

const DEFAULT_EDIT_REASON_OPTIONS = [
  'customer_request',
  'pricing_correction',
  'policy_exception',
  'other',
]

/**
 * Validate edit reason fields against the envelope's editReason config.
 * Returns null on success or { error, status } on failure.
 * When config is omitted, validates with default optional controls.
 */
export function validateEditReason(args: {
  editReason?: string
  editReasonText?: string
  editReasonConfig?: EditReasonConfig
}): { error: string; status: 400 } | null {
  const { editReason, editReasonText, editReasonConfig } = args

  // Default: both controls optional when config is omitted
  const dropdownConfig = editReasonConfig?.dropdown === false ? null : editReasonConfig?.dropdown ?? {}
  const textConfig = editReasonConfig?.text === false ? null : editReasonConfig?.text ?? {}

  // Validate dropdown
  if (dropdownConfig) {
    if (dropdownConfig.required && (!editReason || !editReason.trim())) {
      return { error: 'Edit reason dropdown is required', status: 400 }
    }
    if (editReason) {
      const options = dropdownConfig.options ?? DEFAULT_EDIT_REASON_OPTIONS
      const allowedValues = options.map((opt) => (typeof opt === 'string' ? opt : opt.value))
      if (!allowedValues.includes(editReason)) {
        return { error: `Edit reason must be one of: ${allowedValues.join(', ')}`, status: 400 }
      }
    }
  }

  // Validate text
  if (textConfig) {
    const maxLength = textConfig.maxLength ?? 2000
    if (textConfig.required && (!editReasonText || !editReasonText.trim())) {
      return { error: 'Edit reason text is required', status: 400 }
    }
    if (editReasonText && editReasonText.length > maxLength) {
      return { error: `Edit reason text exceeds maximum length ${maxLength}`, status: 400 }
    }
  }

  return null
}

/**
 * Merge and validate edited args against the envelope's editableFields allowlist.
 * Returns { mergedArgs, editedDelta } on success or { error, status } on failure.
 */
export function mergeEditableArgs(args: {
  originalArgs: Record<string, unknown>
  editedArgs: Record<string, unknown>
  editableFields: Record<string, EditableFieldSpec>
}): { mergedArgs: Record<string, unknown>; editedDelta: Record<string, unknown> } | { error: string; status: 400 } {
  const { originalArgs, editedArgs, editableFields } = args
  const allowedKeys = Object.keys(editableFields)

  const editedDelta: Record<string, unknown> = {}
  const mergedArgs = { ...originalArgs }

  for (const key of Object.keys(editedArgs)) {
    if (!allowedKeys.includes(key)) {
      return { error: `Field "${key}" is not editable`, status: 400 }
    }
    const field = editableFields[key]!
    const value = editedArgs[key]

    if (field.type === 'string') {
      if (typeof value !== 'string') {
        return { error: `Field "${key}" must be a string`, status: 400 }
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        return { error: `Field "${key}" is below min length ${field.minLength}`, status: 400 }
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return { error: `Field "${key}" exceeds max length ${field.maxLength}`, status: 400 }
      }
      editedDelta[key] = value
      mergedArgs[key] = value
    } else if (field.type === 'int') {
      if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
        return { error: `Field "${key}" must be an integer`, status: 400 }
      }
      if (field.min !== undefined && value < field.min) {
        return { error: `Field "${key}" is below minimum ${field.min}`, status: 400 }
      }
      if (field.max !== undefined && value > field.max) {
        return { error: `Field "${key}" exceeds maximum ${field.max}`, status: 400 }
      }
      editedDelta[key] = value
      mergedArgs[key] = value
    } else if (field.type === 'float') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: `Field "${key}" must be a finite number`, status: 400 }
      }
      if (field.min !== undefined && value < field.min) {
        return { error: `Field "${key}" is below minimum ${field.min}`, status: 400 }
      }
      if (field.max !== undefined && value > field.max) {
        return { error: `Field "${key}" exceeds maximum ${field.max}`, status: 400 }
      }
      editedDelta[key] = value
      mergedArgs[key] = value
    } else if (field.type === 'bool') {
      if (typeof value !== 'boolean') {
        return { error: `Field "${key}" must be a boolean`, status: 400 }
      }
      editedDelta[key] = value
      mergedArgs[key] = value
    } else if (field.type === 'enum') {
      if (typeof value !== 'string') {
        return { error: `Field "${key}" must be a string`, status: 400 }
      }
      if (!field.options || field.options.length === 0) {
        return { error: `Field "${key}" has no valid options`, status: 400 }
      }
      const allowedValues = field.options.map((opt) =>
        typeof opt === 'string' ? opt : opt.value
      )
      if (!allowedValues.includes(value)) {
        return { error: `Field "${key}" must be one of: ${allowedValues.join(', ')}`, status: 400 }
      }
      editedDelta[key] = value
      mergedArgs[key] = value
    } else if (field.type === 'array') {
      if (!Array.isArray(value)) {
        return { error: `Field "${key}" must be an array`, status: 400 }
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return { error: `Field "${key}" requires at least ${field.minItems} items`, status: 400 }
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return { error: `Field "${key}" exceeds maximum ${field.maxItems} items`, status: 400 }
      }
      for (const item of value) {
        if (field.items === 'string' && typeof item !== 'string') {
          return { error: `Field "${key}" must contain only strings`, status: 400 }
        }
        if (field.items === 'int' && (typeof item !== 'number' || !Number.isInteger(item) || !Number.isFinite(item))) {
          return { error: `Field "${key}" must contain only integers`, status: 400 }
        }
        if (field.items === 'float' && (typeof item !== 'number' || !Number.isFinite(item))) {
          return { error: `Field "${key}" must contain only finite numbers`, status: 400 }
        }
      }
      editedDelta[key] = value
      mergedArgs[key] = value
    }
  }

  return { mergedArgs, editedDelta }
}

export function parseDecisionBody(body: Record<string, unknown>): DecisionPayload | null {
  if (!isDecision(body.decision)) return null
  const decision = body.decision as Decision
  
  // Edit requires editedArgs (we'll compute final_sha256 server-side)
  if (decision === 'edit') {
    const hasEditedArgs = body.editedArgs && typeof body.editedArgs === 'object'
    if (!hasEditedArgs) return null
  }
  
  return {
    decision,
    editedArgs:
      body.editedArgs && typeof body.editedArgs === 'object' ? (body.editedArgs as Record<string, unknown>) : undefined,
    response: typeof body.response === 'string' ? body.response : undefined,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    editReason: typeof body.editReason === 'string' ? body.editReason : undefined,
    editReasonText: typeof body.editReasonText === 'string' ? body.editReasonText : undefined,
  }
}

/** Slim origin-poll payload. Authenticate with the project API key used at ingest. */
/**
 * Requester read with a project API key (hitl-spec section 4): the legacy
 * fields plus the full hitl/response/v0 shape (`hitl`, null while open),
 * `argsHash` (JCS, hitl-spec 3.8) over the stored original args, `activity`,
 * and `editedArgs` when the approver amended the arguments.
 */
export async function getApprovalForOrigin(args: { apiKey: string; approvalId: string }) {
  const authn = await authenticateProjectKey(args.apiKey)
  if (!authn) return { ok: false as const, error: 'Invalid API key', status: 401 as const }

  return withTenant(authn.project.workspaceId, async () => {
    await touchApiKey(authn.key.id)
    const database = requireDb()
    const workspaceId = authn.project.workspaceId
    const approval = await loadApproval(args.approvalId, workspaceId)
    if (!approval || approval.projectId !== authn.project.id) {
      return { ok: false as const, error: 'Not found', status: 404 as const }
    }

    const decisionRows = await database
      .select({
        decision: decisionRecords.decision,
        payload: decisionRecords.payload,
        actorUserId: decisionRecords.actorUserId,
        createdAt: decisionRecords.createdAt,
      })
      .from(decisionRecords)
      .where(and(eq(decisionRecords.approvalId, approval.id), eq(decisionRecords.workspaceId, workspaceId)))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(1)
    const latest = decisionRows[0]
    const payload = latest?.payload
      ? await decodeTenantJson(workspaceId, latest.payload as Record<string, unknown>)
      : {}
    const decision = latest && isDecision(latest.decision) ? latest.decision : undefined

    const openRows = await database
      .select({ payload: projectEvents.payload, createdAt: projectEvents.createdAt })
      .from(projectEvents)
      .where(
        and(
          eq(projectEvents.approvalId, approval.id),
          eq(projectEvents.workspaceId, workspaceId),
          eq(projectEvents.type, 'opened'),
        ),
      )
    const opens = openRows.flatMap((row) => {
      const event = row.payload as { itemRef?: unknown; openedAt?: unknown } | null
      if (!event || typeof event.itemRef !== 'string' || !event.itemRef) return []
      const openedAt = typeof event.openedAt === 'string' ? event.openedAt : row.createdAt.toISOString()
      return [{ itemRef: event.itemRef, openedAt }]
    })

    const envelope = asEnvelope(approval.envelope)
    const read = await buildHitlRead({
      approval,
      envelope,
      decision: latest && decision ? { decision, payload, actorUserId: latest.actorUserId, createdAt: latest.createdAt } : null,
      opens,
      mergeEdits: (edited) => {
        if (!envelope.editableFields) return null
        const merged = mergeEditableArgs({
          originalArgs: envelope.action.args,
          editedArgs: edited,
          editableFields: envelope.editableFields,
        })
        return 'error' in merged ? null : merged.mergedArgs
      },
    })

    return {
      ok: true as const,
      id: approval.id,
      status: approval.status,
      decision,
      response: typeof payload.response === 'string' ? payload.response : undefined,
      // hitl-spec 4.3: null when the request was never shown to a reviewer.
      presentedAt: approval.presentedAt ? approval.presentedAt.toISOString() : null,
      ...read,
    }
  })
}

export async function countApprovalsThisMonth(workspaceId: string) {
  return withTenant(workspaceId, async () => {
    const start = new Date()
    start.setUTCDate(1)
    start.setUTCHours(0, 0, 0, 0)
    const database = requireDb()
    const rows = await database
      .select({ n: sql<number>`count(*)` })
      .from(approvals)
      .where(and(eq(approvals.workspaceId, workspaceId), gte(approvals.createdAt, start)))
    return Number(rows[0]?.n ?? 0)
  })
}

