import { and, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import { AWAITING_HUMAN_APPROVAL_STATUSES, isDecision, type Decision } from '@hitly/core'
import { approvals, decisionRecords } from '@hitly/db/schema'
import { settleExpiredApproval } from './approvals'
import { effectiveApprovalStatus } from './approval-expiry'
import { logProjectEvent } from './events'
import { requireDb, withTenant } from './tenant'
import { decodeTenantJson } from './tenant-crypto'
import { NextResponse } from 'next/server'
import { isWellFormedApiKey } from './keys'

/**
 * Key-scoped authoritative reads for the `@hitly/mastra-factory-plugin`.
 *
 * The plugin's restart reconciliation needs what the generic requester list
 * (`GET /api/v1/approvals`) and the hitl-spec `get_decision` view do not
 * expose: the gate classification and the Factory session identity the plugin
 * stamped at create time (`net.hitly/*` metadata, stored on the envelope's
 * resumeHandle — the same carrier the decided callback replays). Keeping
 * these reads in the plugin's own namespace avoids widening the shared,
 * spec-governed response shapes.
 */

const GATE_KEY = 'net.hitly/gate'

export interface MastraFactoryOpenApproval {
  id: string
  status: string
  decision: null
  gate: string
  metadata: Record<string, unknown>
}

export interface MastraFactoryApprovalState {
  id: string
  status: string
  decision: string | null
  metadata: Record<string, unknown>
  reason?: string
  editedArgs?: Record<string, unknown>
  response?: string
  answer?: string
}

/** Create-time metadata: the resumeHandle bag is authoritative (the decided callback replays exactly this bag). */
function approvalMetadata(envelope: Record<string, unknown> | undefined): Record<string, unknown> {
  const fromHandle = (envelope?.origin as { resumeHandle?: { metadata?: unknown } } | undefined)?.resumeHandle?.metadata
  if (typeof fromHandle === 'object' && fromHandle !== null) return fromHandle as Record<string, unknown>
  const direct = envelope?.metadata
  if (typeof direct === 'object' && direct !== null) return direct as Record<string, unknown>
  return {}
}

async function decodeEnvelope(workspaceId: string, envelope: Record<string, unknown> | null | undefined) {
  if (!envelope) return undefined
  return (await decodeTenantJson(workspaceId, envelope)) as Record<string, unknown> | undefined
}

/** Open mastra-factory approvals for the project — unexpired pending rows plus decided-but-undelivered (`failed_resume`) rows — with gate + session identity. */
export async function listOpenMastraFactoryApprovals(args: { workspaceId: string; projectId: string }) {
  const now = new Date()
  const rows = await requireDb()
    .select({
      id: approvals.id,
      status: approvals.status,
      envelope: approvals.envelope,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, args.projectId),
        eq(approvals.workspaceId, args.workspaceId),
        inArrayOpen(),
        // The deadline only gates rows still awaiting a human; a
        // failed_resume row already holds that human's decision, which must
        // converge even after the deadline passed.
        or(eq(approvals.status, 'failed_resume'), isNull(approvals.expiresAt), gte(approvals.expiresAt, now)),
      ),
    )
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(200)
  const items: MastraFactoryOpenApproval[] = []
  for (const row of rows) {
    const envelope = await decodeEnvelope(args.workspaceId, row.envelope)
    const metadata = approvalMetadata(envelope)
    const gate = metadata[GATE_KEY]
    // Gate-less rows are not this plugin's gates; the plugin would only be
    // able to fail them closed, so keep them out of the reconciliation feed.
    if (typeof gate !== 'string' || !gate) continue
    items.push({ id: row.id, status: row.status, decision: null, gate, metadata })
  }
  return { approvals: items }
}

function inArrayOpen() {
  // Two feeds: rows still awaiting a human (AWAITING_HUMAN_APPROVAL_STATUSES
  // is ['pending']) plus `failed_resume` rows — a human decided but the
  // callback exhausted HITLy's ~1s retries, and HITLy has no auto-retry, so
  // the plugin's reconciler is what converges them after a Factory restart.
  return inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES, 'failed_resume'])
}

/** Authoritative per-approval state (read-time expiry settled), or null when not in the project. */
export async function getMastraFactoryApprovalState(args: {
  workspaceId: string
  projectId: string
  approvalId: string
}): Promise<MastraFactoryApprovalState | null> {
  const database = requireDb()
  const rows = await database
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, args.approvalId), eq(approvals.projectId, args.projectId), eq(approvals.workspaceId, args.workspaceId)))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  // Read-time expiry: a past-deadline pending row must never read `pending`
  // here, or the plugin could still treat it as approvable.
  await settleExpiredApproval(row, args.workspaceId)
  const status = effectiveApprovalStatus(row)

  const decisionRows = await database
    .select({ decision: decisionRecords.decision, payload: decisionRecords.payload })
    .from(decisionRecords)
    .where(and(eq(decisionRecords.approvalId, row.id), eq(decisionRecords.workspaceId, args.workspaceId)))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1)
  const latest = decisionRows[0]
  const payload = latest?.payload
    ? ((await decodeTenantJson(args.workspaceId, latest.payload as Record<string, unknown>)) as Record<string, unknown>)
    : {}
  const decision: Decision | undefined = latest && isDecision(latest.decision) ? latest.decision : undefined

  const envelope = await decodeEnvelope(args.workspaceId, row.envelope as Record<string, unknown> | undefined)
  const state: MastraFactoryApprovalState = {
    id: row.id,
    status,
    decision: decision ?? null,
    metadata: approvalMetadata(envelope),
  }
  if (typeof payload.reason === 'string' && payload.reason) state.reason = payload.reason
  if (typeof payload.editedArgs === 'object' && payload.editedArgs !== null) state.editedArgs = payload.editedArgs as Record<string, unknown>
  if (typeof payload.response === 'string') state.response = payload.response
  if (typeof payload.answer === 'string') state.answer = payload.answer
  return state
}

export type MastraFactoryAckResult = { status: string } | { error: string; status: 404 | 409 }

/**
 * Settle a `failed_resume` row the host has converged: the plugin calls this
 * after it has applied the recorded decision, so the row leaves the open
 * feed instead of replaying `decided` on every future restart. Only a row
 * whose latest decision record is a real decision may settle this way —
 * decision-less `failed_resume` rows stay open for a late decision or a
 * manual Retry-Resume. Re-acking a `decided` row is an idempotent success.
 */
export async function ackMastraFactoryResume(args: {
  workspaceId: string
  projectId: string
  approvalId: string
}): Promise<MastraFactoryAckResult> {
  const database = requireDb()
  const rows = await database
    .select({ id: approvals.id, status: approvals.status })
    .from(approvals)
    .where(
      and(
        eq(approvals.id, args.approvalId),
        eq(approvals.projectId, args.projectId),
        eq(approvals.workspaceId, args.workspaceId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return { error: 'Not found', status: 404 }
  if (row.status === 'decided') return { status: 'decided' }
  if (row.status !== 'failed_resume') return { error: 'Approval is not in failed_resume', status: 409 }

  const decisionRows = await database
    .select({ decision: decisionRecords.decision })
    .from(decisionRecords)
    .where(and(eq(decisionRecords.approvalId, row.id), eq(decisionRecords.workspaceId, args.workspaceId)))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1)
  const latest = decisionRows[0]
  if (!latest || !isDecision(latest.decision)) return { error: 'No decision to acknowledge', status: 409 }

  await database
    .update(approvals)
    .set({ status: 'decided', updatedAt: new Date() })
    .where(and(eq(approvals.id, row.id), eq(approvals.workspaceId, args.workspaceId)))
  await logProjectEvent({
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    approvalId: row.id,
    type: 'resumed',
    message: `Host acknowledged resume (decision ${latest.decision})`,
    payload: { decision: latest.decision, ack: true, previousStatus: 'failed_resume' },
  })
  return { status: 'decided' }
}

export interface MastraFactoryApprovalsDeps {
  authenticate: (
    apiKey: string,
    projectId: string,
  ) => Promise<{ project: { plugin: string; workspaceId: string } } | null>
  applyRestReadLimit: (subject: string) => Promise<NextResponse | null>
  applyRestWriteLimit: (subject: string) => Promise<NextResponse | null>
  applyFailedAuth: (request: Request) => Promise<NextResponse | null>
  listOpen: (projectId: string, workspaceId: string) => Promise<{ approvals: MastraFactoryOpenApproval[] }>
  readState: (projectId: string, workspaceId: string, approvalId: string) => Promise<MastraFactoryApprovalState | null>
  ack: (projectId: string, workspaceId: string, approvalId: string) => Promise<MastraFactoryAckResult>
}

async function authenticateKeyedProject(
  request: Request,
  projectId: string,
  deps: MastraFactoryApprovalsDeps,
  applyLimit: (subject: string) => Promise<NextResponse | null> = deps.applyRestReadLimit,
): Promise<{ failure: NextResponse } | { project: { plugin: string; workspaceId: string } }> {
  const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!apiKey) return { failure: NextResponse.json({ error: 'Missing API key' }, { status: 401 }) } as const
  if (!isWellFormedApiKey(apiKey)) {
    const failed = await deps.applyFailedAuth(request)
    return { failure: failed ?? NextResponse.json({ error: 'Invalid API key or project' }, { status: 401 }) } as const
  }
  const authn = await deps.authenticate(apiKey, projectId)
  if (!authn) {
    const failed = await deps.applyFailedAuth(request)
    return { failure: failed ?? NextResponse.json({ error: 'Invalid API key or project' }, { status: 401 }) } as const
  }
  const limited = await applyLimit(apiKey)
  if (limited) return { failure: limited } as const
  if (authn.project.plugin !== 'mastra-factory') {
    return { failure: NextResponse.json({ error: 'Not found' }, { status: 404 }) } as const
  }
  return { project: authn.project } as const
}

/**
 * GET /api/v1/projects/:id/integrations/mastra-factory/approvals — the
 * plugin's restart-seed feed: open gate approvals with the gate + Factory
 * session identity captured at create time.
 */
export async function handleMastraFactoryApprovalsList(request: Request, projectId: string, deps: MastraFactoryApprovalsDeps) {
  const auth = await authenticateKeyedProject(request, projectId, deps)
  if ('failure' in auth) return auth.failure
  const result = await deps.listOpen(projectId, auth.project.workspaceId)
  return NextResponse.json(result)
}

/**
 * GET /api/v1/projects/:id/integrations/mastra-factory/approvals/:approvalId —
 * the plugin's authority read: authoritative status/decision (the plugin
 * trusts only this, never the callback's claim) plus the decision payload.
 */
export async function handleMastraFactoryApprovalGet(
  request: Request,
  projectId: string,
  approvalId: string,
  deps: MastraFactoryApprovalsDeps,
) {
  const auth = await authenticateKeyedProject(request, projectId, deps)
  if ('failure' in auth) return auth.failure
  const state = await deps.readState(projectId, auth.project.workspaceId, approvalId)
  if (!state) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(state)
}

/**
 * POST /api/v1/projects/:id/integrations/mastra-factory/approvals/:approvalId/resume-ack —
 * the host's receipt that it converged a `failed_resume` decision. Settles
 * the row to `decided` so it leaves the restart feed; a second process
 * replaying against an already-converged row gets an idempotent success.
 */
export async function handleMastraFactoryResumeAck(
  request: Request,
  projectId: string,
  approvalId: string,
  deps: MastraFactoryApprovalsDeps,
) {
  const auth = await authenticateKeyedProject(request, projectId, deps, deps.applyRestWriteLimit)
  if ('failure' in auth) return auth.failure
  const result = await deps.ack(projectId, auth.project.workspaceId, approvalId)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ id: approvalId, status: result.status })
}
