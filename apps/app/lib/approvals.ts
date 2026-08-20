import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { edition } from '@hitly/cloud'
import {
  isDecision,
  isOpenApprovalStatus,
  isPluginId,
  OPEN_APPROVAL_STATUSES,
  originResumeError,
  type ApprovalEnvelope,
  type ChannelType,
  type Decision,
  type DecisionPayload,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'
import { approvals, decisionRecords, projectApiKeys, projectRules, projects } from '@hitly/db/schema'
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
import { appendEvidence, buildDecidedEvent, buildRequestedEvent, buildResumedEvent, loadLatestReceipt } from './evidence'
import { exportOtelTrace } from './otel-trace'

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
    const existing = await database
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, project.workspaceId),
          eq(approvals.projectId, project.id),
          eq(approvals.idempotencyKey, args.idempotencyKey),
          inArray(approvals.status, OPEN_APPROVAL_STATUSES),
        ),
      )
      .limit(1)
    if (existing[0]) {
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

    const latest = await loadLatestReceipt(approval.id, workspaceId)
    let decidedEventId: string | undefined
    let decidedContentSha256: string | undefined
    try {
      const decidedEvent = await buildDecidedEvent({
        approvalId: approval.id,
        envelope,
        origin,
        payload: args.payload,
        reviewerId: args.actorUserId,
        seq: latest.seq + 1,
        prevEventId: latest.prevEventId ?? '',
        prevContentSha256: latest.prevContentSha256 ?? '',
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
          args.payload,
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
        resumeError = error instanceof Error ? error.message : 'Resume failed'
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
      payload: { decision: args.payload.decision },
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
    return decideApproval({
      approvalId: approval.id,
      actorUserId: record.actorUserId ?? '',
      payload,
      workspaceId,
    })
  })
}

export function parseDecisionBody(body: Record<string, unknown>): DecisionPayload | null {
  if (!isDecision(body.decision)) return null
  const decision = body.decision as Decision
  
  // Edit requires both editedArgs (delta) and final_sha256
  if (decision === 'edit') {
    const hasEditedArgs = body.editedArgs && typeof body.editedArgs === 'object'
    const hasFinalSha = typeof body.final_sha256 === 'string' && body.final_sha256.length > 0
    if (!hasEditedArgs || !hasFinalSha) return null
  }
  
  return {
    decision,
    editedArgs:
      body.editedArgs && typeof body.editedArgs === 'object' ? (body.editedArgs as Record<string, unknown>) : undefined,
    response: typeof body.response === 'string' ? body.response : undefined,
  }
}

/** Slim origin-poll payload. Authenticate with the project API key used at ingest. */
export async function getApprovalForOrigin(args: { apiKey: string; approvalId: string }) {
  const authn = await authenticateProjectKey(args.apiKey)
  if (!authn) return { ok: false as const, error: 'Invalid API key', status: 401 as const }

  return withTenant(authn.project.workspaceId, async () => {
    await touchApiKey(authn.key.id)
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, authn.project.workspaceId)
    if (!approval || approval.projectId !== authn.project.id) {
      return { ok: false as const, error: 'Not found', status: 404 as const }
    }

    const decisionRows = await database
      .select({
        decision: decisionRecords.decision,
        payload: decisionRecords.payload,
      })
      .from(decisionRecords)
      .where(and(eq(decisionRecords.approvalId, approval.id), eq(decisionRecords.workspaceId, authn.project.workspaceId)))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(1)
    const latest = decisionRows[0]
    const payload = latest?.payload
      ? await decodeTenantJson(authn.project.workspaceId, latest.payload as Record<string, unknown>)
      : {}
    const decision = latest && isDecision(latest.decision) ? latest.decision : undefined

    return {
      ok: true as const,
      id: approval.id,
      status: approval.status,
      decision,
      response: typeof payload.response === 'string' ? payload.response : undefined,
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

