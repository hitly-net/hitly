import { and, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import { AWAITING_HUMAN_APPROVAL_STATUSES, isDecision, type Decision } from '@hitly/core'
import { approvals, decisionRecords } from '@hitly/db/schema'
import { settleExpiredApproval } from './approvals'
import { effectiveApprovalStatus } from './approval-expiry'
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

/** Open (pending, unexpired) mastra-factory approvals for the project, with gate + session identity. */
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
        or(isNull(approvals.expiresAt), gte(approvals.expiresAt, now)),
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
  // AWAITING_HUMAN_APPROVAL_STATUSES is ['pending']; kept as the shared
  // constant so a future widening of "awaiting human" flows through here too.
  return inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES])
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

export interface MastraFactoryApprovalsDeps {
  authenticate: (
    apiKey: string,
    projectId: string,
  ) => Promise<{ project: { plugin: string; workspaceId: string } } | null>
  applyRestReadLimit: (subject: string) => Promise<NextResponse | null>
  applyFailedAuth: (request: Request) => Promise<NextResponse | null>
  listOpen: (projectId: string, workspaceId: string) => Promise<{ approvals: MastraFactoryOpenApproval[] }>
  readState: (projectId: string, workspaceId: string, approvalId: string) => Promise<MastraFactoryApprovalState | null>
}

async function authenticateKeyedProject(
  request: Request,
  projectId: string,
  deps: MastraFactoryApprovalsDeps,
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
  const limited = await deps.applyRestReadLimit(apiKey)
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
