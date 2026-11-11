import { and, asc, desc, eq, gt, gte, inArray, or, sql } from 'drizzle-orm'
import { edition } from '@hitly/cloud'
import {
  AWAITING_HUMAN_APPROVAL_STATUSES,
  isDecision,
  isOpenApprovalStatus,
  isPluginId,
  OPEN_APPROVAL_STATUSES,
  originResumeError,
  validateAnswerSubmission,
  validateDecisionAnswer,
  validateRequestGating,
  validateTypedAnswer,
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
import { approvals, decisionRecords, evidenceReceipts, projectApiKeys, projectEvents, projectRules, projects, users } from '@hitly/db/schema'
import { getPlugin } from './plugins'
import { envelopeMetadata, stripOriginSecrets } from './origin'
import { hashApiKey } from './keys'
import { logProjectEvent } from './events'
import { notifyAssignee } from './notify'
import { parseRuleActions, parseRuleMatch, ruleMatches } from './rules'
import { ensureProjectResumeSecret } from './resume-secret'
import { ensureProjectWebhookSecret } from './webhook-secret'
import { deliverApprovalLifecycleEvent } from './lifecycle-delivery'
import { affectedRows } from './housekeeping/result'
import { newId } from './ids'
import { requireDb, requireTenantWorkspaceId, withTenant } from './tenant'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'
import { approvalHasExpired, effectiveApprovalStatus } from './approval-expiry'
import { appendEvidence, buildDecidedEvent, buildPresentedEvent, buildRequestedEvent, buildResumedEvent, loadLatestReceipt } from './evidence'
import { ingestBlockedForProjectStatus, mutationBlockedForProjectStatus } from './project-lifecycle'
import { canDecide, getProjectAccess } from './rbac'
import { loadOpenedContextRefs } from './context-opens'
import { exportOtelTrace } from './otel-trace'
import { resumeFailureMessage } from './resume-error'
import { createOnceCutoff, envelopePayloadHash } from './create-once'
import { buildHitlRead } from './hitl-response'
import { clampListLimit, olderThanListCursor, takeListPage, type ListCursor } from './list-cursor'

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

async function refuseIfProjectArchived(projectId: string, workspaceId: string) {
  const rows = await requireDb()
    .select({ status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  const blocked = mutationBlockedForProjectStatus(rows[0]?.status ?? 'live')
  if (!blocked) return null
  return { error: blocked.error, code: blocked.code, status: 409 as const }
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
async function resolveReviewerActor(
  database: ReturnType<typeof requireDb>,
  actorUserId: string,
): Promise<EvidenceActor | undefined> {
  // S97-S4: never emit `decidedBy.id: ''` after the reviewer row is gone
  // (`decision_records.actor_user_id` is ON DELETE SET NULL).
  if (!actorUserId) return undefined
  let display: string | undefined
  if (EVIDENCE_INCLUDE_ACTOR_DISPLAY) {
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

const EVIDENCE_CHANNELS = new Set<EvidenceClient['channel']>(['web', 'mobile', 'api'])
const EVIDENCE_ACTOR_KINDS = new Set<EvidenceActor['kind']>(['human', 'group', 'service'])

/** Snapshot stored on `decision_records.client` (tenant-encrypted) so retry reuses actor + device. */
type StoredDecisionContext = {
  client?: EvidenceClient
  actor?: EvidenceActor
}

function asEvidenceClient(value: unknown): EvidenceClient | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!EVIDENCE_CHANNELS.has(raw.channel as EvidenceClient['channel'])) return undefined
  const client: EvidenceClient = { channel: raw.channel as EvidenceClient['channel'] }
  if (raw.platform === 'ios' || raw.platform === 'android') client.platform = raw.platform
  if (typeof raw.appVersion === 'string' && raw.appVersion) client.appVersion = raw.appVersion
  if (typeof raw.userAgent === 'string' && raw.userAgent) client.userAgent = raw.userAgent
  return client
}

function asEvidenceActor(value: unknown): EvidenceActor | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!EVIDENCE_ACTOR_KINDS.has(raw.kind as EvidenceActor['kind'])) return undefined
  if (typeof raw.id !== 'string' || !raw.id) return undefined
  return {
    kind: raw.kind as EvidenceActor['kind'],
    id: raw.id,
    ...(typeof raw.display === 'string' && raw.display ? { display: raw.display } : {}),
  }
}

function decodeStoredDecisionContext(raw: unknown): StoredDecisionContext {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  // Pre-S4 rows stored a bare EvidenceClient (`{channel, platform?, ...}`).
  if (typeof obj.channel === 'string' && !('client' in obj) && !('actor' in obj)) {
    return { client: asEvidenceClient(obj) }
  }
  return {
    client: asEvidenceClient(obj.client),
    actor: asEvidenceActor(obj.actor),
  }
}

/**
 * A `presented` record may only be written for an ask that has NOT been
 * decided yet (hitl-spec 5.2/5.4: requested -> presented -> decided).
 *
 * B1 (hitly#97): migration 0004 added `presented_at` as NULL with no backfill,
 * so pre-migration rows can be `failed_resume` (an open status) with
 * `presented_at IS NULL`. Appending `presented` there would land AFTER
 * `decided` — false evidence, because a decided item was necessarily shown.
 *
 * Status `pending` is not enough. A late duplicate `presented` can still
 * arrive after a terminal decision (`decided` / accept or reject,
 * `expired`, `cancelled`, or `failed_resume`) when `presented_at` is NULL.
 * The S97-S2 race check used `indexOf`, which only sees the first of each
 * type and would still pass if a second `presented` landed after `decided`.
 * Always look at `decision_records` and at decided/resume receipts: any
 * prior decision means skip. Does not change state and does not appear as
 * a fresh presentation after decided.
 */
async function mayRecordPresented(
  database: ReturnType<typeof requireDb>,
  approvalId: string,
  workspaceId: string,
): Promise<boolean> {
  const decidedRows = await database
    .select({ id: decisionRecords.id })
    .from(decisionRecords)
    .where(and(eq(decisionRecords.approvalId, approvalId), eq(decisionRecords.workspaceId, workspaceId)))
    .limit(1)
  if (decidedRows.length > 0) return false

  const terminal = await database
    .select({ eventType: evidenceReceipts.eventType })
    .from(evidenceReceipts)
    .where(
      and(
        eq(evidenceReceipts.approvalId, approvalId),
        eq(evidenceReceipts.workspaceId, workspaceId),
        inArray(evidenceReceipts.eventType, ['decided', 'resumed', 'resume_failed']),
      ),
    )
    .limit(1)
  return terminal.length === 0
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
    if (mutationBlockedForProjectStatus(access.project.status)) return { presentedAt: null }
    if (!canDecide(access)) return { presentedAt: null }
    if (approval.presentedAt) return { presentedAt: approval.presentedAt.toISOString() }
    if (!isOpenApprovalStatus(approval.status) || approvalHasExpired(approval)) {
      return { presentedAt: null }
    }
    // Legacy rows from before migration 0004 have presented_at NULL even when
    // already decided (failed_resume is an open status). A late `presented`
    // would land after `decided` in the chain: false evidence, never recorded.
    if (!(await mayRecordPresented(database, approval.id, workspaceId))) {
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
      if (!actor) return { presentedAt: presentedAt.toISOString() }
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

    // Opt-in HTTP lifecycle callback (item 6): no-op unless the request opted
    // in via lifecycleEvents at ingest; the default stays a single final POST.
    await deliverApprovalLifecycleEvent({
      approval: {
        id: approval.id,
        projectId: approval.projectId,
        plugin: approval.plugin,
        origin: approval.origin,
      },
      workspaceId,
      type: 'presented',
    })

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

type LoadedProject = Awaited<ReturnType<typeof decodeProject<typeof projects.$inferSelect>>>
type IngestedEnvelope = ApprovalEnvelope & { origin: OriginRef }

async function ingestBodyToEnvelope(args: {
  body: Record<string, unknown>
  project: LoadedProject
}): Promise<{ ok: true; ingested: IngestedEnvelope } | { ok: false; error: string; status: 400 }> {
  const pluginId = args.body.plugin ?? args.project.plugin
  if (!isPluginId(pluginId) || pluginId !== args.project.plugin) {
    await logProjectEvent({
      projectId: args.project.id,
      level: 'error',
      type: 'ingest',
      message: `Plugin mismatch: expected ${args.project.plugin}`,
    })
    return { ok: false as const, error: `Project is configured for ${args.project.plugin}`, status: 400 as const }
  }

  const merged = withProjectCredentials(args.body, args.project)
  let ingested: IngestedEnvelope
  try {
    ingested = getPlugin(pluginId).ingest(merged)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed'
    await logProjectEvent({
      projectId: args.project.id,
      level: 'error',
      type: 'ingest',
      message,
    })
    return { ok: false as const, error: message, status: 400 as const }
  }

  const gatingErrors = validateRequestGating(ingested)
  if (gatingErrors.length > 0) {
    const message = `Invalid gating config: ${gatingErrors.map((error) => `${error.field}: ${error.message}`).join('; ')}`
    await logProjectEvent({
      projectId: args.project.id,
      level: 'error',
      type: 'ingest',
      message,
    })
    return { ok: false as const, error: message, status: 400 as const }
  }

  ingested.origin.projectId = args.project.id
  if (pluginId === 'mastra' && !ingested.origin.resumeHandle.mastraBaseUrl && typeof args.project.credentials.baseUrl === 'string') {
    ingested.origin.resumeHandle.mastraBaseUrl = args.project.credentials.baseUrl
  }
  return { ok: true as const, ingested }
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
  // Deadline precedence (hitl-spec 3.3, PM ruling): an EXPLICIT caller
  // deadline on the envelope is authoritative and is never clamped down to
  // the project SLA; otherwise the matched rule's slaMinutes, then the
  // project's default timeout, then 24h (the published default). The project
  // "60" timeout therefore only shapes requests that set no deadline.
  const envelopeExpiry = args.envelope.expiresAt ? new Date(args.envelope.expiresAt) : null
  const explicitExpiry = envelopeExpiry && !Number.isNaN(envelopeExpiry.getTime()) ? envelopeExpiry : null
  const projectSla = Number(args.project.defaultSlaMinutes)
  const slaMinutes = actions.slaMinutes ?? (Number.isFinite(projectSla) && projectSla > 0 ? projectSla : null)
  const expiresAt =
    explicitExpiry ??
    (slaMinutes != null
      ? new Date(Date.now() + Math.max(slaMinutes, 1) * 60_000)
      : new Date(Date.now() + DEFAULT_REQUEST_WINDOW_MS))
  const channelTypes: ChannelType[] = actions.channelTypes?.length ? actions.channelTypes : ['email']
  return {
    matched,
    expiresAt,
    channelTypes,
    assignedUserId: args.project.defaultAssigneeUserId,
  }
}

type IngestedApproval = NonNullable<Awaited<ReturnType<typeof loadApproval>>>
type IngestApprovalResult =
  | { ok: true; replayed: boolean; approval: IngestedApproval }
  | { ok: false; error: string; status: 400 | 401 | 409 | 500; code?: string }

export async function ingestApproval(args: {
  apiKey: string
  body: Record<string, unknown>
  idempotencyKey?: string | null
  /** Clock for the create-once window (tests). */
  now?: number
}): Promise<IngestApprovalResult> {
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
    // retention window (lib/create-once.ts). Newest matching row wins
    // (created_at DESC, id DESC as the tie-break). Same payloadHash (JCS of
    // the ingested envelope) replays the stored request; a different payloadHash
    // is 409 idempotency_conflict so a changed body is never silently recorded.
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
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(1)
    if (existing[0]) {
      const incoming = await ingestBodyToEnvelope({ body: args.body, project })
      if (!incoming.ok) return incoming
      const storedEnvelope = await decodeTenantJson(project.workspaceId, existing[0].envelope)
      const storedHash = await envelopePayloadHash(storedEnvelope)
      const incomingHash = await envelopePayloadHash(incoming.ingested)
      if (storedHash !== incomingHash) {
        await logProjectEvent({
          workspaceId: project.workspaceId,
          projectId: project.id,
          approvalId: existing[0].id,
          type: 'ingest',
          level: 'warn',
          // approvalId belongs on the log line; never log the request payload or secrets.
          message: `Create-once conflict: payloadHash does not match the stored request (approvalId=${existing[0].id})`,
          payload: { conflict: true, code: 'idempotency_conflict', requesterKeyId: key.id },
        })
        return {
          ok: false as const,
          error: 'Idempotency-Key reused with a different payload',
          code: 'idempotency_conflict' as const,
          status: 409 as const,
        }
      }
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
          envelope: storedEnvelope,
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

  const ingestBlock = ingestBlockedForProjectStatus(project.status)
  if (ingestBlock) {
    return {
      ok: false as const,
      error: ingestBlock.error,
      code: ingestBlock.code,
      status: 409 as const,
    }
  }

  const prepared = await ingestBodyToEnvelope({ body: args.body, project })
  if (!prepared.ok) return prepared
  const ingested = prepared.ingested
  const pluginId = ingested.origin.plugin

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
    // M0h: the create-once envelope column must never carry origin credentials
    // (cb_auth_token). They live only on the origin column, which the reviewer
    // read projections redact and resume() reads. See lib/origin.ts.
    envelope: await encodeTenantJson(project.workspaceId, {
      ...ingested,
      origin: stripOriginSecrets(ingested.origin),
    } as unknown as Record<string, unknown>),
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
  /** Set by retryResume: reuse the snapshotted actor (frozen display, no empty id). */
  decidedBy?: EvidenceActor
}) {
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  return withTenant(workspaceId, async () => {
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, workspaceId, { forUpdate: true })
    if (!approval) return { error: 'Not found', status: 404 as const }
    const archived = await refuseIfProjectArchived(approval.projectId, workspaceId)
    if (archived) return archived
    if (approvalHasExpired(approval)) {
      await settleExpiredApproval(approval, workspaceId)
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

    // Typed answer re-validation (hitl-spec 3.4/7): when the request stored an
    // answerSchema, the respond decision must carry `answer: {kind, value}`
    // whose kind equals the STORED type and whose value satisfies the stored
    // options/bounds. A bare `response` is refused as a substitute; the host
    // never trims or coerces the value. No stored schema keeps the legacy
    // free-text respond path (in-flight asks from before persistence landed).
    const answerErrors = validateDecisionAnswer(envelope, args.payload)
    if (answerErrors.length > 0) {
      return {
        error: answerErrors.map((error) => `${error.field}: ${error.message}`).join('; '),
        status: 400 as const,
        fields: answerErrors,
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
    const reviewerActor = args.decidedBy ?? (await resolveReviewerActor(database, args.actorUserId))

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
      reviewerActor &&
      (await mayRecordPresented(database, approval.id, workspaceId))
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
      // Opt-in HTTP lifecycle callback for the implicit first-show (item 6).
      await deliverApprovalLifecycleEvent({
        approval: {
          id: approval.id,
          projectId: approval.projectId,
          plugin: approval.plugin,
          origin: approval.origin,
        },
        workspaceId,
        type: 'presented',
      })
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
        // Callbacks sign with the DEDICATED webhook key (item 9), provisioned
        // on demand; the resume secret stays reserved for origin polls.
        const webhooked = secured ? await ensureProjectWebhookSecret(secured.project) : null
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
          secured
            ? { plugin: approval.plugin, ...(webhooked ? webhooked.project.credentials : secured.project.credentials) }
            : undefined,
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

    const storedContext: StoredDecisionContext = {
      ...(args.client ? { client: args.client } : {}),
      ...(reviewerActor ? { actor: reviewerActor } : {}),
    }
    await database.insert(decisionRecords).values({
      id: newId('dec').slice(0, 36),
      workspaceId,
      approvalId: approval.id,
      actorUserId: args.actorUserId || null,
      decision: args.payload.decision,
      payload: await encodeTenantJson(workspaceId, args.payload as unknown as Record<string, unknown>),
      client:
        storedContext.client || storedContext.actor
          ? await encodeTenantJson(workspaceId, storedContext as unknown as Record<string, unknown>)
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
    const archived = await refuseIfProjectArchived(approval.projectId, workspaceId)
    if (archived) return archived
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
    // Opt-in HTTP lifecycle callback (item 6): no-op unless the request opted in.
    await deliverApprovalLifecycleEvent({
      approval: {
        id: approval.id,
        projectId: approval.projectId,
        plugin: approval.plugin,
        origin: approval.origin,
      },
      workspaceId,
      type: 'cancelled',
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
    const archived = await refuseIfProjectArchived(approval.projectId, workspaceId)
    if (archived) return { ok: false as const, error: archived.error, code: archived.code, status: archived.status }
    if (approvalHasExpired(approval)) {
      await settleExpiredApproval(approval, workspaceId)
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

/** Host-side default request window when nobody set a deadline (hitl-spec 3.3). */
export const DEFAULT_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Settle a past-deadline pending row: flip it to `expired` with a guarded
 * update (exactly one caller wins per row) and fire the opt-in `expired`
 * lifecycle callback in the winner only. Every read surface calls this so a
 * row never reports stale `pending` before the hourly sweeper runs; existing
 * rows already past expiry are settled with no data migration.
 * Returns the status the read must report.
 */
export async function settleExpiredApproval(
  approval: { id: string; status: string; expiresAt: Date | null; projectId: string; plugin: string; origin: Record<string, unknown> },
  workspaceId: string,
  now: number = Date.now(),
): Promise<string> {
  if (approval.status !== 'pending') return approval.status
  if (approval.expiresAt == null || approval.expiresAt.getTime() >= now) return approval.status
  const database = requireDb()
  const result = await database
    .update(approvals)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(approvals.id, approval.id),
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.status, 'pending'),
      ),
    )
  // Only the flip winner sends the expiry callback: exactly once per request.
  if (affectedRows(result) > 0) {
    await logProjectEvent({
      workspaceId,
      projectId: approval.projectId,
      approvalId: approval.id,
      type: 'expired',
      message: 'Request expired',
    })
    await deliverApprovalLifecycleEvent({
      approval: { id: approval.id, projectId: approval.projectId, plugin: approval.plugin, origin: approval.origin },
      workspaceId,
      type: 'expired',
    })
  }
  return 'expired'
}

/**
 * Settle every past-deadline pending row in the given projects before a
 * pending list or count runs, so the shared `status = 'pending'` filters
 * cannot list or count already-expired requests. Bounded: surfaces re-check
 * on the next call; the hourly sweeper is the backstop.
 */
export async function settleExpiredApprovalsInProjects(
  workspaceId: string,
  projectIds: string[],
  now: number = Date.now(),
): Promise<void> {
  if (projectIds.length === 0) return
  const database = requireDb()
  const stale = await database
    .select({
      id: approvals.id,
      projectId: approvals.projectId,
      plugin: approvals.plugin,
      origin: approvals.origin,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, workspaceId),
        inArray(approvals.projectId, projectIds),
        eq(approvals.status, 'pending'),
        sql`${approvals.expiresAt} is not null`,
        sql`${approvals.expiresAt} < to_timestamp(${now / 1000})`,
      ),
    )
    .limit(200)
  for (const row of stale) {
    await settleExpiredApproval({ ...row, status: 'pending', expiresAt: new Date(now - 1) }, workspaceId, now)
  }
}

export const REQUESTER_PENDING_DEFAULT_LIMIT = 50
export const REQUESTER_PENDING_MAX_LIMIT = 200

/**
 * The requester's open requests: created by this API key, in its project,
 * still awaiting a human (`pending` and not past their deadline). Newest first.
 * `failed_resume` rows already carry a human decision, so they are excluded
 * here (shared definition: AWAITING_HUMAN_APPROVAL_STATUSES in @hitly/core).
 * The resume failure stays visible via get_decision / the operator REST status.
 */
export async function listRequesterPending(args: {
  apiKey: string
  projectId?: string
  limit?: number
  cursor?: ListCursor
}) {
  const authn = await authenticateProjectKey(args.apiKey, args.projectId)
  if (!authn) return { ok: false as const, error: 'Invalid API key or project', status: 401 as const }
  if ('status' in authn.project && authn.project.status === 'archived') {
    return { ok: true as const, projectId: authn.project.id, nextCursor: null, items: [] }
  }
  const workspaceId = authn.project.workspaceId
  const limit = clampListLimit(args.limit, REQUESTER_PENDING_DEFAULT_LIMIT, REQUESTER_PENDING_MAX_LIMIT)
  return withTenant(workspaceId, async () => {
    await touchApiKey(authn.key.id)
    const now = new Date()
    // Past-deadline pending rows are settled to `expired` first (and fire
    // their one expiry callback), then the shared filters below exclude them.
    await settleExpiredApprovalsInProjects(workspaceId, [authn.project.id], now.getTime())
    const filters = [
      eq(approvals.workspaceId, workspaceId),
      eq(approvals.projectId, authn.project.id),
      eq(approvals.requesterKeyId, authn.key.id),
      and(
        inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES]),
        or(sql`${approvals.expiresAt} is null`, gte(approvals.expiresAt, now)),
      ),
    ]
    const cursorWhere = args.cursor ? olderThanListCursor(approvals.createdAt, approvals.id, args.cursor) : undefined
    if (cursorWhere) filters.push(cursorWhere)
    const rows = await requireDb()
      .select({
        id: approvals.id,
        status: approvals.status,
        actionName: approvals.actionName,
        idempotencyKey: approvals.idempotencyKey,
        createdAt: approvals.createdAt,
        expiresAt: approvals.expiresAt,
        presentedAt: approvals.presentedAt,
        envelope: approvals.envelope,
      })
      .from(approvals)
      .where(and(...filters))
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(limit + 1)
    const { page, nextCursor } = takeListPage(rows, limit)
    return {
      ok: true as const,
      projectId: authn.project.id,
      nextCursor,
      items: await Promise.all(
        page.map(async (row) => {
          // ask_user rows are `question`s, everything else an `approval`; the
          // headline (prompt / question) rides along so requester clients can
          // show what is open without a second get_decision per row.
          const envelope = (await decodeTenantJson(workspaceId, row.envelope)) as unknown as
            | (ApprovalEnvelope & { _meta?: Record<string, unknown> })
            | undefined
          const isQuestion = row.actionName === 'ask_user'
          const question =
            typeof envelope?._meta?.question === 'string'
              ? envelope._meta.question
              : typeof envelope?._meta?.['net.hitly/question'] === 'string'
                ? envelope._meta['net.hitly/question']
                : undefined
          const prompt = typeof envelope?.prompt === 'string' ? envelope.prompt : undefined
          return {
            id: row.id,
            kind: (isQuestion ? 'question' : 'approval') as 'question' | 'approval',
            status: effectiveApprovalStatus(row, now.getTime()),
            actionName: row.actionName,
            idempotencyKey: row.idempotencyKey,
            createdAt: row.createdAt.toISOString(),
            deadline: row.expiresAt ? row.expiresAt.toISOString() : null,
            presentedAt: row.presentedAt ? row.presentedAt.toISOString() : null,
            ...(isQuestion ? (prompt ? { prompt } : {}) : {}),
            ...(!isQuestion ? (question ? { question } : {}) : {}),
          }
        }),
      ),
    }
  })
}

export async function retryResume(args: { approvalId: string; workspaceId?: string }) {
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  return withTenant(workspaceId, async () => {
    const database = requireDb()
    const approval = await loadApproval(args.approvalId, workspaceId)
    if (!approval) return { error: 'Not found', status: 404 as const }
    const archived = await refuseIfProjectArchived(approval.projectId, workspaceId)
    if (archived) return archived
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
    // A retry must not relabel the original decider's device or display: reuse
    // the STORED client and actor. The retry itself is marked in the project
    // event only (payload.retry), never in oversight.client.
    const stored = record.client
      ? decodeStoredDecisionContext(await decodeTenantJson(workspaceId, record.client))
      : {}
    return decideApproval({
      approvalId: approval.id,
      actorUserId: record.actorUserId ?? '',
      payload,
      workspaceId,
      client: stored.client,
      ...(stored.actor ? { decidedBy: stored.actor } : {}),
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

  // Typed answer (ask_user, hitl-spec 7): carried verbatim into the decision
  // payload and the origin callback (`type: 'answered'`). A present-but-malformed
  // answer is refused as an invalid decision (400) - it must NEVER be silently
  // dropped, or the reviewer's answer would vanish from the audit trail.
  const answerError = validateTypedAnswer(body.answer)
  if (answerError) return null

  return {
    decision,
    editedArgs:
      body.editedArgs && typeof body.editedArgs === 'object' ? (body.editedArgs as Record<string, unknown>) : undefined,
    response: typeof body.response === 'string' ? body.response : undefined,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    editReason: typeof body.editReason === 'string' ? body.editReason : undefined,
    editReasonText: typeof body.editReasonText === 'string' ? body.editReasonText : undefined,
    ...(body.answer !== undefined ? { answer: body.answer } : {}),
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
    // Read-time expiry: a past-deadline pending row must read `expired` here
    // too (get_decision included), with the flip + one expiry callback, never
    // a stale `pending` until the sweeper happens to run.
    await settleExpiredApproval(approval, workspaceId)
    const readStatus = effectiveApprovalStatus(approval)

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
    // No callback_url at create time => the HTTP plugin stored no resumeUrl
    // and decide skipped resume() by design: zero outbound calls. Report the
    // delivery outcome honestly as 'none' (never 'failed') so requester
    // reads distinguish "no callback was ever configured" from a broken one.
    // Only surfaced for decided requests without a stored resumeUrl; reads
    // of requests that had a callback are unchanged.
    const storedResumeHandle = (approval.origin as { resumeHandle?: Record<string, unknown> } | null)?.resumeHandle
    const storedResumeUrl = typeof storedResumeHandle?.resumeUrl === 'string' ? storedResumeHandle.resumeUrl.trim() : ''
    const noCallbackDelivery =
      approval.plugin === 'http' && !storedResumeUrl && (readStatus === 'decided' || readStatus === 'failed_resume')
    const read = await buildHitlRead({
      approval: { ...approval, status: readStatus },
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
      status: readStatus,
      decision,
      response: typeof payload.response === 'string' ? payload.response : undefined,
      // The reviewer's typed ask_user answer (hitl-spec 7), verbatim from the
      // stored decision payload. A respond decision carries only `response`
      // text; without this field the typed answer the human entered would be
      // invisible to the requester's get_decision. Carried on the response
      // only - the stored request and decision payload are never mutated.
      // Absent means OMITTED, never null: a stored literal null (legacy rows)
      // is treated as no answer, matching MCP toResponseV0's null drop.
      ...(payload.answer !== undefined && payload.answer !== null ? { answer: payload.answer } : {}),
      ...(noCallbackDelivery ? { callbackDelivery: 'none' as const } : {}),
      // hitl-spec 4.3: null when the request was never shown to a reviewer.
      presentedAt: approval.presentedAt ? approval.presentedAt.toISOString() : null,
      ...read,
      // Top-level copy of the stored ask_user schema (hitl-spec 3.4). Null
      // when the request has none (legacy asks). Not nested on `hitl` —
      // hitl/response/v0 forbids extra properties. Origin clients sent this
      // schema at ingest; it is not reviewer-redacted here.
      answerSchema: envelope.answerSchema ?? null,
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

