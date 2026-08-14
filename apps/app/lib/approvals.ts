import { and, asc, desc, eq, inArray } from 'drizzle-orm'
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
import { requireDb } from './require-db'
import { approvalHasExpired } from './approval-expiry'

export async function authenticateProjectKey(rawKey: string, projectId?: string) {
  const database = requireDb()
  const hashed = hashApiKey(rawKey)
  const keyRows = await database.select().from(projectApiKeys).where(eq(projectApiKeys.hashedKey, hashed)).limit(1)
  const key = keyRows[0]
  if (!key) return null
  if (projectId && key.projectId !== projectId) return null
  const projectRows = await database.select().from(projects).where(eq(projects.id, key.projectId)).limit(1)
  const project = projectRows[0]
  if (!project) return null
  await database.update(projectApiKeys).set({ lastUsedAt: new Date() }).where(eq(projectApiKeys.id, key.id))
  return { key, project }
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
    .where(eq(projectRules.projectId, args.project.id))
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

  const { project } = authn
  const database = requireDb()

  if (args.idempotencyKey) {
    const existing = await database
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.projectId, project.id),
          eq(approvals.idempotencyKey, args.idempotencyKey),
          inArray(approvals.status, OPEN_APPROVAL_STATUSES),
        ),
      )
      .limit(1)
    if (existing[0]) {
      return { ok: true as const, approval: existing[0], replayed: true }
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
    envelope: ingested as unknown as Record<string, unknown>,
    origin: ingested.origin as unknown as Record<string, unknown>,
    idempotencyKey: args.idempotencyKey ?? null,
    expiresAt: routed.expiresAt,
  })

  await logProjectEvent({
    projectId: project.id,
    approvalId,
    type: 'ingest',
    message: `Ingested ${ingested.action.name}`,
    payload: {
      plugin: pluginId,
      runId: ingested.origin.runId,
      action: ingested.action,
      allowedActions: ingested.allowedActions,
      contextMarkdown: ingested.contextMarkdown,
      resumeSchema: ingested.resumeSchema,
      expiresAt: ingested.expiresAt,
      origin: ingested.origin,
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

  const created = await database.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  if (!created[0]) {
    return { ok: false as const, error: 'Failed to persist approval', status: 500 as const }
  }
  return { ok: true as const, approval: created[0], replayed: false }
}

export async function decideApproval(args: {
  approvalId: string
  actorUserId: string
  payload: DecisionPayload
}) {
  const database = requireDb()
  const rows = await database.select().from(approvals).where(eq(approvals.id, args.approvalId)).limit(1)
  const approval = rows[0]
  if (!approval) return { error: 'Not found', status: 404 as const }
  if (approvalHasExpired(approval)) {
    if (approval.status === 'pending') {
      await database.update(approvals).set({ status: 'expired' }).where(eq(approvals.id, approval.id))
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
  const projectRows = await database.select().from(projects).where(eq(projects.id, approval.projectId)).limit(1)
  const project = projectRows[0]
  if (project && origin.plugin === 'mastra' && !origin.resumeHandle.mastraBaseUrl) {
    origin.resumeHandle.mastraBaseUrl = project.credentials.baseUrl
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
    } catch (error) {
      resumeError = error instanceof Error ? error.message : 'Resume failed'
      status = 'failed_resume'
    }
  }

  await database.insert(decisionRecords).values({
    id: newId('dec').slice(0, 36),
    approvalId: approval.id,
    actorUserId: args.actorUserId,
    decision: args.payload.decision,
    payload: args.payload as unknown as Record<string, unknown>,
    resumeError,
    resumeResponse: resumeResponse as unknown as Record<string, unknown> | null,
  })
  await database.update(approvals).set({ status }).where(eq(approvals.id, approval.id))
  await logProjectEvent({
    projectId: approval.projectId,
    approvalId: approval.id,
    level: resumeError ? 'error' : 'info',
    type: resumeError ? 'resume' : 'decided',
    message: resumeError ?? `Decision ${args.payload.decision}`,
    payload: {
      decision: args.payload.decision,
      resumeResponse,
      action: envelope.action,
      contextMarkdown: envelope.contextMarkdown,
      origin,
    },
  })

  const updated = await database.select().from(approvals).where(eq(approvals.id, approval.id)).limit(1)
  return { approval: updated[0], resumeError, resumeResponse, status }
}

export async function cancelApproval(args: { approvalId: string; actorUserId: string }) {
  const database = requireDb()
  const rows = await database.select().from(approvals).where(eq(approvals.id, args.approvalId)).limit(1)
  const approval = rows[0]
  if (!approval) return { error: 'Not found', status: 404 as const }
  if (!isOpenApprovalStatus(approval.status)) {
    return { error: 'Approval is not open', status: 409 as const }
  }

  const envelope = asEnvelope(approval.envelope)
  const origin = asOrigin(approval.origin)
  await database.insert(decisionRecords).values({
    id: newId('dec').slice(0, 36),
    approvalId: approval.id,
    actorUserId: args.actorUserId,
    decision: 'cancel',
    payload: { decision: 'cancel' },
    resumeError: null,
    resumeResponse: null,
  })
  await database.update(approvals).set({ status: 'cancelled' }).where(eq(approvals.id, approval.id))
  await logProjectEvent({
    projectId: approval.projectId,
    approvalId: approval.id,
    type: 'cancelled',
    message: 'Force cancelled without resuming the origin',
    payload: {
      decision: 'cancel',
      previousStatus: approval.status,
      action: envelope.action,
      origin,
    },
  })
  const updated = await database.select().from(approvals).where(eq(approvals.id, approval.id)).limit(1)
  return { approval: updated[0], status: 'cancelled' as const }
}

export async function retryResume(args: { approvalId: string }) {
  const database = requireDb()
  const rows = await database.select().from(approvals).where(eq(approvals.id, args.approvalId)).limit(1)
  const approval = rows[0]
  if (!approval) return { error: 'Not found', status: 404 as const }
  if (approval.status !== 'failed_resume') {
    return { error: 'Approval is not in failed_resume', status: 409 as const }
  }
  const decisionRows = await database
    .select()
    .from(decisionRecords)
    .where(eq(decisionRecords.approvalId, approval.id))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1)
  const record = decisionRows[0]
  if (!record || !isDecision(record.decision)) {
    return { error: 'No decision to retry', status: 409 as const }
  }
  return decideApproval({
    approvalId: approval.id,
    actorUserId: record.actorUserId ?? '',
    payload: record.payload as unknown as DecisionPayload,
  })
}

export function parseDecisionBody(body: Record<string, unknown>): DecisionPayload | null {
  if (!isDecision(body.decision)) return null
  const decision = body.decision as Decision
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

  const database = requireDb()
  const rows = await database.select().from(approvals).where(eq(approvals.id, args.approvalId)).limit(1)
  const approval = rows[0]
  if (!approval || approval.projectId !== authn.project.id) {
    return { ok: false as const, error: 'Not found', status: 404 as const }
  }

  const decisionRows = await database
    .select({
      decision: decisionRecords.decision,
      payload: decisionRecords.payload,
    })
    .from(decisionRecords)
    .where(eq(decisionRecords.approvalId, approval.id))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1)
  const latest = decisionRows[0]
  const payload = latest?.payload && typeof latest.payload === 'object' ? (latest.payload as Record<string, unknown>) : {}
  const decision = latest && isDecision(latest.decision) ? latest.decision : undefined

  return {
    ok: true as const,
    id: approval.id,
    status: approval.status,
    decision,
    response: typeof payload.response === 'string' ? payload.response : undefined,
  }
}
