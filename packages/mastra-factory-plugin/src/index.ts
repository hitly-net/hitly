import { buildApprovalRequest, detectGate, idempotencyKeyFor, isGateTool, METADATA_KEYS, RESUME_PATH, type HitlyClientLike } from './gates.ts'
import { handleResumeRequest, type ResumeDeps } from './resume.ts'
import { applyDecision, type ApplyDeps } from './apply.ts'
import {
  closeGateAsDecidedElsewhere,
  createMemoryGateStateStore,
  detectFactoryResolution,
  gateStateKey,
  type GateCloseOutcome,
  type GateRecord,
  type GateStateStore,
} from './gate-state.ts'
import { HitlyReconciler, type OpenApproval } from './worker.ts'
import type { FactoryProjectLister, HitlyConnectionRegistry, ResolvedConnection } from './connections.ts'
import { buildSettingsRoutes, type SettingsRouteAuth } from './settings-routes.ts'
import { registerHitlyConnectionCard } from './hitly-connection-card.ts'
import type { ApprovalSnapshot, Gate, PluginRuntimeConfig } from './types.ts'

export { DEFAULT_POLL_INTERVAL_MS, parseRuntimeConfig, parseDeploymentConfig, type HitlyDeploymentConfig } from './config.ts'

// Interim Factory Connections card registry (hitly-net/hitly#218). Other
// plugins register their own card with these until upstream ships the
// extension point (#211); everything here goes away with the UI patch.
export {
  registerConnectionCard,
  unregisterConnectionCard,
  listConnectionCards,
  clearConnectionCards,
  collectConnectionCards,
  DEFAULT_CARD_TIMEOUT_MS,
  DEFAULT_STATUS_LABELS,
  type ConnectionCard,
  type ConnectionCardContext,
  type ConnectionCardResult,
  type ConnectionCardStatus,
  type ConnectionCardView,
} from './connection-cards.ts'
export { createHitlyConnectionCard, registerHitlyConnectionCard, HITLY_CARD_ID } from './hitly-connection-card.ts'

/**
 * Session-identity extraction is injected so this module never imports
 * `@mastra/*` at runtime. The Factory host passes the real implementation
 * from `@hitly/mastra-factory-plugin/factory-seams` (the single module
 * allowed to touch upstream internals — see docs/SPIKE.md).
 */
export interface SessionTargetSeams {
  resolveSessionTarget(requestContext: unknown): {
    sessionId: string
    threadId?: string
    orgId?: string
    userId?: string
    factoryProjectId?: string
  } | null
}

/** The session identity a gate is attached to, as resolved by the host seams. */
type GateSessionTarget = NonNullable<ReturnType<SessionTargetSeams['resolveSessionTarget']>>

/** Resume-side wiring also injected, so @mastra/factory deep imports stay in factory-seams. */
export interface ApplySeams {
  answerParked(args: {
    sessionId: string
    orgId?: string
    userId?: string
    toolCallId?: string
    decision: 'approve' | 'decline'
    reason: string
  }): Promise<void>
  signalSession(args: { sessionId: string; threadId?: string; message: string }): Promise<void>
}

export interface HitlyPluginOptions {
  /**
   * Deployment-level env config. With a `registry` this is bootstrap +
   * publicBaseUrl/poll source and env-fallback credentials; without one
   * (tests, single-project wiring) it is also the gate config as before.
   */
  config: PluginRuntimeConfig
  client: HitlyClientLike
  seams: SessionTargetSeams
  applySeams?: ApplySeams
  /**
   * Per-factory HITLy connections (#211). When present, every gate call is
   * routed through the factory's own connection — no connection → no HITLy
   * items — and resume callbacks verify with that connection's secrets.
   */
  registry?: HitlyConnectionRegistry
  /**
   * Per-gate memory (who decided which tool call). The Factory host wires a
   * durable store so the Factory-side close and the conflict refusal survive
   * a restart; the default is process-local.
   */
  gateStore?: GateStateStore
  /**
   * Which Factory surface answered a gate (`ui` | `mcp` | `auto-approve`). The
   * resumed tool output carries no channel metadata, so the host supplies it
   * when it can; anything recorded is reported verbatim in the conflict note.
   */
  resolveFactoryDecisionChannel?(args: { gate: Gate; sessionId: string; toolCallId: string }): string | undefined
  /** HITLy project-config overrides (authoritative once fetched; env is bootstrap/fallback). */
  gateOverrides?: Partial<Record<Gate, boolean>>
  mergeAfterAcceptOverride?: boolean
  attemptMerge?: ApplyDeps['attemptMerge']
  markMergeReady?: ApplyDeps['markMergeReady']
  log?(level: string, message: string, meta?: Record<string, unknown>): void
}

const SEEN_TTL_MS = 10 * 60 * 1000
const SEEN_MAX = 2000
const GITHUB_PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/

function extractPr(output: unknown): { url: string; headSha?: string } | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const record = output as Record<string, unknown>
  const url =
    (typeof record.prUrl === 'string' && record.prUrl) ||
    (typeof record.changeRequestUrl === 'string' && record.changeRequestUrl) ||
    (typeof record.url === 'string' && record.url) ||
    undefined
  if (!url || !GITHUB_PR_URL.test(url)) return undefined
  let headSha: string | undefined
  if (typeof record.headSha === 'string') headSha = record.headSha
  else if (typeof record.commitId === 'string') headSha = record.commitId
  else if (typeof record.head === 'object' && record.head !== null && typeof (record.head as { sha?: unknown }).sha === 'string') {
    headSha = (record.head as { sha: string }).sha
  }
  return { url, headSha }
}

function metaString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key]
  return typeof value === 'string' && value ? value : undefined
}

/** Accepts a raw Request (tests) or the host's Hono context (production). */
function rawRequestFrom(context: unknown): Request {
  if (context instanceof Request) return context
  const candidate = context as { req?: { raw?: unknown } } | null
  if (candidate?.req?.raw instanceof Request) return candidate.req.raw
  throw new TypeError('hitly resume: expected a Request or Hono context')
}

/**
 * Pull the factoryProjectId out of a `.../resume/<fpid>` request URL.
 * Done from the URL rather than hono's `c.req.param()` so the same code
 * path serves raw Requests (tests) and the mounted route (production).
 */
export function extractFactoryProjectId(request: Request): string | undefined {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${RESUME_PATH}/`)) return undefined
  const rest = pathname.slice(RESUME_PATH.length + 1)
  if (!rest || rest.includes('/')) return undefined
  try {
    return decodeURIComponent(rest) || undefined
  } catch {
    return rest
  }
}

const VALID_GATES: readonly Gate[] = ['plan', 'review', 'ask_user']

function snapshotFromDispatch(cmd: import('./resume.ts').ResumeDispatch): ApprovalSnapshot | null {
  if (!VALID_GATES.includes(cmd.gate as Gate)) return null
  const snapshot: ApprovalSnapshot = {
    id: cmd.approvalId,
    status: 'decided',
    decision: cmd.decision,
    gate: cmd.gate as Gate,
    metadata: cmd.metadata,
  }
  const sessionId = metaString(cmd.metadata, METADATA_KEYS.sessionId)
  if (sessionId) snapshot.sessionId = sessionId
  const threadId = metaString(cmd.metadata, METADATA_KEYS.threadId)
  if (threadId) snapshot.threadId = threadId
  const toolCallId = metaString(cmd.metadata, METADATA_KEYS.toolCallId)
  if (toolCallId) snapshot.toolCallId = toolCallId
  const orgId = metaString(cmd.metadata, METADATA_KEYS.orgId)
  if (orgId) snapshot.orgId = orgId
  const userId = metaString(cmd.metadata, METADATA_KEYS.userId)
  if (userId) snapshot.userId = userId
  const factoryProjectId = metaString(cmd.metadata, METADATA_KEYS.projectId)
  if (factoryProjectId) snapshot.factoryProjectId = factoryProjectId
  const headSha = metaString(cmd.metadata, METADATA_KEYS.headSha)
  if (headSha) snapshot.headSha = headSha
  const prUrl = metaString(cmd.metadata, METADATA_KEYS.prUrl)
  if (prUrl) snapshot.prUrl = prUrl
  if (cmd.reason) snapshot.reason = cmd.reason
  if (cmd.editedArgs) snapshot.editedArgs = cmd.editedArgs
  if (cmd.response) snapshot.response = cmd.response
  return snapshot
}

/**
 * FactoryIntegration implementation. Constructed on the Factory host:
 *   new MastraFactory({ integrations: [new HitlyMastraFactoryPlugin({ config, seams, applySeams })] })
 *
 * Structural typing against @mastra/factory's FactoryIntegration is verified
 * in factory-seams.ts (the only module with upstream type imports).
 */
export class HitlyMastraFactoryPlugin {
  readonly id = 'hitly'
  private readonly options: HitlyPluginOptions
  private gates: Record<Gate, boolean>
  private mergeAfterAccept: boolean
  private readonly seenEvents = new Map<string, number>()
  private readonly appliedDecisions = new Set<string>()
  private readonly openApprovals = new Map<string, OpenApproval>()
  /** approvalId → cbAuthToken generated at create, verified on resume callbacks. */
  private readonly cbAuthTokens = new Map<string, string>()
  /** runId → generated token held between create start and create resolve. */
  private readonly pendingCbAuthTokens = new Map<string, string>()
  private readonly gateStore: GateStateStore
  /** Per-gate-key serialization of observer passes: the resume pass must see
   *  the record the suspend pass wrote. */
  private readonly observerQueue = new Map<string, Promise<void>>()
  private seededFromHitly = false
  /** Connections whose open set has been re-seeded from HITLy (restart backstop). */
  private readonly seededConnections = new Set<string>()
  private reconciler?: HitlyReconciler

  constructor(options: HitlyPluginOptions) {
    this.options = options
    this.gates = { ...options.config.gates, ...(options.gateOverrides ?? {}) }
    this.mergeAfterAccept = options.mergeAfterAcceptOverride ?? options.config.mergeAfterAccept
    this.gateStore = options.gateStore ?? createMemoryGateStateStore()
    // Interim Settings → Connections card (hitly-net/hitly#218) until upstream
    // ships the extension point (#211). Status is resolved lazily, so the card
    // is right whether the registry came in with these options or arrived later
    // through attachRegistry().
    registerHitlyConnectionCard({ getRegistry: () => this.options.registry ?? null })
  }

  /**
   * Attach the connection registry after construction. Host storage (where
   * connections live) only arrives with the IntegrationContext, so
   * createHitlyIntegration builds and attaches the registry there. A
   * registry passed up front is never replaced.
   */
  attachRegistry(registry: HitlyConnectionRegistry): void {
    if (!this.options.registry) this.options.registry = registry
  }

  /** Refresh gate state from HITLy (source of truth). Fail-closed: never called with stale/failed reads. */
  updateRemoteConfig(remote: { gates: Record<Gate, boolean>; mergeAfterAccept: boolean }): void {
    this.gates = { ...remote.gates }
    this.mergeAfterAccept = remote.mergeAfterAccept
  }

  routes(ctx: unknown): Array<{
    path: string
    method: 'GET' | 'POST'
    requiresAuth: boolean
    handler: (context: unknown) => Promise<Response>
  }> {
    const handler = (context: unknown) => this.handleResume(rawRequestFrom(context))
    // HITLy posts with its own per-approval bearer + HMAC signature — it has
    // no Factory interactive auth, and the signature IS the credential.
    // The un-parameterized path stays for rows created before per-factory
    // URLs (and for legacy single-project wiring without a registry).
    const routes: Array<{
      path: string
      method: 'GET' | 'POST'
      requiresAuth: boolean
      handler: (context: unknown) => Promise<Response>
    }> = [
      { path: `${RESUME_PATH}/:factoryProjectId`, method: 'POST', requiresAuth: false, handler },
      { path: RESUME_PATH, method: 'POST', requiresAuth: false, handler },
    ]
    if (this.options.registry) {
      // Interim admin surface until upstream ships a Connections extension
      // point (#211). Auth/tenant/admin gating happens inside the handlers,
      // against the host context's RouteAuth (fail-closed when absent).
      const host = ctx as { auth?: SettingsRouteAuth; storage?: { projects?: FactoryProjectLister } } | null
      routes.push(
        ...buildSettingsRoutes({
          registry: this.options.registry,
          auth: host?.auth,
          projects: host?.storage?.projects,
          log: this.options.log,
        }),
      )
    }
    return routes
  }

  /** Route a gate call / callback to the factory's connection (registry mode). */
  private async resolveConnectionFor(session: {
    orgId?: string
    factoryProjectId?: string
  }): Promise<ResolvedConnection | null> {
    const registry = this.options.registry
    if (!registry || !session.factoryProjectId) return null
    if (session.orgId) return registry.resolve(session.orgId, session.factoryProjectId)
    return registry.resolveByFactoryProjectId(session.factoryProjectId)
  }

  private clientFor(conn: ResolvedConnection | null): HitlyClientLike {
    if (conn && this.options.registry) return this.options.registry.clientFor(conn)
    return this.options.client
  }

  private async handleResume(request: Request): Promise<Response> {
    const rawBody = await request.text()
    const factoryProjectId = extractFactoryProjectId(request)
    let conn: ResolvedConnection | null = null
    if (factoryProjectId && this.options.registry) {
      conn = await this.options.registry.resolveByFactoryProjectId(factoryProjectId)
      if (!conn) {
        // Disconnected or never connected: nothing to authenticate against.
        // 404 stops HITLy retries; in-flight approvals converge (or expire)
        // via the reconcile worker while the connection existed.
        this.options.log?.('warn', 'hitly resume: no connection for factory', { factoryProjectId })
        return new Response(JSON.stringify({ error: 'unknown_connection' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    const client = this.clientFor(conn)
    // Event ids are unique per HITLy project; scope the dedupe store by
    // factory so two projects can never shadow each other's events.
    const eventScope = conn ? `${conn.factoryProjectId}|` : ''
    const deps: ResumeDeps = {
      dedupe: {
        check: (eventId) => this.seenEvents.has(eventScope + eventId),
        remember: (eventId) => this.remember(this.seenEvents, eventScope + eventId),
      },
      bearerFor: (approvalId) => this.cbAuthTokens.get(approvalId),
      fetchApprovalState: async (approvalId) => {
        if (!client.getApproval) throw Object.assign(new Error('no approval read path'), { status: 502 })
        const state = await client.getApproval(approvalId)
        if (conn) {
          const owner = state.metadata?.[METADATA_KEYS.projectId]
          if (typeof owner === 'string' && owner && owner !== conn.factoryProjectId) {
            // Wrong factory's approval reached this factory's callback URL.
            // The per-approval bearer already gates it; this is the belt.
            this.options.log?.('warn', 'hitly resume: approval belongs to another factory', {
              approvalId,
              factoryProjectId: conn.factoryProjectId,
            })
            throw Object.assign(new Error('cross-factory approval'), { status: 404 })
          }
        }
        return state
      },
      apply: (cmd) => this.dispatchApply(cmd),
      log: this.options.log,
    }
    const response = await handleResumeRequest({
      headers: request.headers,
      rawBody,
      config: conn ? conn.config : this.options.config,
      deps,
    })
    if (conn && this.options.registry && response.ok) {
      try {
        await this.options.registry.touchCallback(conn.orgId, conn.factoryProjectId)
      } catch {
        // Status telemetry only.
      }
    }
    return response
  }

  private async dispatchApply(cmd: import('./resume.ts').ResumeDispatch) {
    const snapshot = snapshotFromDispatch(cmd)
    if (!snapshot) return { applied: false, reason: 'unknown gate' }
    const deps = await this.buildApplyDepsFor(snapshot)
    return applyDecision(snapshot, deps)
  }

  async postToolObserver(args: { toolContext: { toolName: string; input: unknown; output?: unknown; error?: unknown; toolCallId?: string; context: unknown }; requestContext?: unknown }): Promise<void> {
    try {
      const toolContext = args.toolContext
      if (!toolContext || toolContext.error) return
      if (!isGateTool(toolContext.toolName)) return
      const session = this.options.seams.resolveSessionTarget(args.requestContext)
      if (!session) {
        this.options.log?.('warn', 'hitly: gate tool call without resolvable session', { toolName: toolContext.toolName })
        return
      }
      const conn = await this.resolveConnectionFor(session)
      if (this.options.registry && !conn) {
        // No saved connection and no env fallback for this factory: the
        // factory simply does not use HITLy — no gate, no pause.
        this.options.log?.('warn', 'hitly: no connection for factory, gate skipped', {
          toolName: toolContext.toolName,
          factoryProjectId: session.factoryProjectId ?? null,
        })
        return
      }
      const gates = conn ? conn.config.gates : this.gates
      const gate = detectGate(toolContext.toolName, gates)
      if (!gate) return
      const toolCallId = typeof toolContext.toolCallId === 'string' && toolContext.toolCallId ? toolContext.toolCallId : 'unknown'
      const key = gateStateKey(session.sessionId, toolCallId, gate)

      // One tool call is observed once per pass (suspend, then resume). The
      // passes must not overlap: the resume pass has to see the record the
      // suspend pass wrote, or it would mirror an already-answered call.
      const queued = (this.observerQueue.get(key) ?? Promise.resolve())
        .then(() => this.observeGate({ gate, toolCallId, session, conn, toolContext }))
        .catch((error: unknown) => {
          this.options.log?.('error', 'hitly: postToolObserver pass failed', {
            gate,
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          if (this.observerQueue.get(key) === queued) this.observerQueue.delete(key)
        })
      this.observerQueue.set(key, queued)
      // Deliberately NOT awaited. Factory awaits this observer around every
      // gated tool call, so awaiting HITLy here would put a remote round-trip
      // — or a hung connection — inside the tool pipeline. A pass that dies
      // mid-flight is picked up by the reconcile worker, and tests wait with
      // drainObserverQueue().
      void queued
    } catch (error) {
      // Never throw into the Factory tool pipeline.
      this.options.log?.('error', 'hitly: postToolObserver failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Wait for every queued observer pass to settle. postToolObserver returns as
   * soon as a pass is queued (it must not block the tool pipeline), so tests
   * and shutdown paths await this instead.
   */
  async drainObserverQueue(): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      const pending = [...this.observerQueue.values()]
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  /**
   * One observer pass for one gate tool call. The gate record is the dedupe
   * (durable, so a restart does not re-mirror) and the state machine:
   *
   * - no record + unresolved pass → mirror the parked call to HITLy
   * - no record + already resolved → nothing to mirror; remember it so a late
   *   HITLy decision on this call is still refused as a conflict
   * - open record + resolved pass → the Factory surface answered first: close
   *   the HITLy item as decided-elsewhere
   * - anything else → already settled, ignore the echo
   */
  private async observeGate(args: {
    gate: Gate
    toolCallId: string
    session: GateSessionTarget
    conn: ResolvedConnection | null
    toolContext: { toolName: string; input: unknown; output?: unknown; context: unknown }
  }): Promise<void> {
    const { gate, toolCallId, session, conn, toolContext } = args
    const key = gateStateKey(session.sessionId, toolCallId, gate)
    const record = await this.gateStore.load(key)
    const resolution = detectFactoryResolution(gate, toolContext.output)

    if (!record) {
      if (resolution) {
        const at = new Date().toISOString()
        await this.gateStore.save({
          key,
          sessionId: session.sessionId,
          toolCallId,
          gate,
          orgId: conn?.orgId ?? session.orgId,
          factoryProjectId: conn?.factoryProjectId ?? session.factoryProjectId,
          status: 'factory_resolved',
          factoryDecision: resolution,
          factoryChannel: this.decisionChannel(gate, session.sessionId, toolCallId),
          factoryResolvedAt: at,
          updatedAt: at,
        })
        this.options.log?.('info', 'hitly: gate resolved in Factory before mirroring', {
          gate,
          sessionId: session.sessionId,
          factoryDecision: resolution,
        })
        return
      }
      await this.openApproval({ gate, toolCallId, session, conn, toolContext })
      return
    }

    if (record.status === 'open' && resolution) {
      await this.closeAsDecidedElsewhere(record, resolution, conn)
      return
    }
    if (record.status === 'factory_resolved' && !record.cancelledAt) {
      // An earlier pass recorded the Factory answer but could not close the
      // HITLy item (no cancel path then, or a transient failure). Retry now;
      // the worker remains the backstop.
      await this.cancelOnHitly(record, conn)
      return
    }
    // open + unresolved (a repeated suspend pass), or settled: nothing to do.
  }

  /** Mirror a parked gate tool call to HITLy and remember it as open. */
  private async openApproval(args: {
    gate: Gate
    toolCallId: string
    session: GateSessionTarget
    conn: ResolvedConnection | null
    toolContext: { toolName: string; input: unknown; output?: unknown; context: unknown }
  }): Promise<void> {
    const { gate, toolCallId, session, conn, toolContext } = args
    const key = gateStateKey(session.sessionId, toolCallId, gate)
    const pr = gate === 'review' ? extractPr(toolContext.output) : undefined
    const request = buildApprovalRequest({
      gate,
      toolCallId,
      session,
      input: toolContext.input,
      output: toolContext.output,
      pr,
      config: conn ? conn.config : this.options.config,
    })
    // Hold the generated cbAuthToken from create start; once HITLy assigns
    // the approval id it is re-keyed for resume-callback verification.
    if (request.cbAuthToken) this.pendingCbAuthTokens.set(request.runId, request.cbAuthToken)
    const client = this.clientFor(conn)
    try {
      const ref = await client.createApproval(
        request as unknown as Record<string, unknown>,
        request.idempotencyKey!,
      )
      const token = this.pendingCbAuthTokens.get(request.runId)
      this.pendingCbAuthTokens.delete(request.runId)
      if (token) this.cbAuthTokens.set(ref.id, token)
      this.openApprovals.set(this.openKey(conn, ref.id), {
        approvalId: ref.id,
        gate,
        metadata: (request.metadata ?? {}) as Record<string, unknown>,
      })
      await this.gateStore.save({
        key,
        sessionId: session.sessionId,
        toolCallId,
        gate,
        orgId: conn?.orgId ?? session.orgId,
        factoryProjectId: conn?.factoryProjectId ?? session.factoryProjectId,
        approvalId: ref.id,
        status: 'open',
        updatedAt: new Date().toISOString(),
      })
      this.options.log?.('info', 'hitly: gate approval opened', {
        gate,
        approvalId: ref.id,
        sessionId: session.sessionId,
        factoryProjectId: conn?.factoryProjectId ?? null,
      })
    } catch (error) {
      this.pendingCbAuthTokens.delete(request.runId)
      // No record persisted: a later observation or the reconciliation worker
      // retries. HITLy create-once keeps the retry safe.
      this.options.log?.('error', 'hitly: failed to open gate approval', {
        gate,
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * The Factory surface answered this gate. Record the Factory answer as
   * authoritative first, then close the HITLy item: a crash between the two
   * leaves the reconciler to retry the cancel, and a late HITLy decision is
   * refused as a conflict either way.
   */
  private async closeAsDecidedElsewhere(
    record: GateRecord,
    decision: string,
    conn: ResolvedConnection | null,
  ): Promise<void> {
    const at = new Date().toISOString()
    const channel = this.decisionChannel(record.gate, record.sessionId, record.toolCallId ?? 'unknown')
    const resolved: GateRecord = {
      ...record,
      status: 'factory_resolved',
      factoryDecision: decision,
      factoryChannel: channel,
      factoryResolvedAt: at,
      updatedAt: at,
    }
    await this.gateStore.save(resolved)
    this.options.log?.('info', 'hitly: gate resolved in Factory, closing HITLy item', {
      gate: record.gate,
      approvalId: record.approvalId,
      sessionId: record.sessionId,
      factoryDecision: decision,
      factoryChannel: channel,
    })
    await this.cancelOnHitly(resolved, conn)
  }

  /**
   * Close the HITLy item on the connection that owns it: an approval created
   * through one factory's HITLy project can only be cancelled with THAT
   * project's credentials, never with the deployment default.
   */
  private async cancelOnHitly(record: GateRecord, conn: ResolvedConnection | null): Promise<GateCloseOutcome> {
    if (!record.approvalId) return 'closed'
    const client = await this.clientForRecord(record, conn)
    if (!client.cancelApproval) {
      this.options.log?.('warn', 'hitly: no requester-cancel path configured; HITLy item left open', {
        approvalId: record.approvalId,
        factoryProjectId: record.factoryProjectId ?? null,
      })
      return 'retry'
    }
    const outcome = await closeGateAsDecidedElsewhere(record, {
      cancelApproval: (approvalId, reason) => client.cancelApproval!(approvalId, reason),
      getApproval: client.getApproval ? (approvalId) => client.getApproval!(approvalId) : undefined,
      annotateApproval: client.annotateApproval
        ? (approvalId, note) => client.annotateApproval!(approvalId, note)
        : undefined,
      save: (next) => this.gateStore.save(next),
      log: this.options.log,
    })
    if (outcome !== 'retry') {
      this.openApprovals.delete(this.openKey(conn, record.approvalId))
      this.cbAuthTokens.delete(record.approvalId)
    }
    return outcome
  }

  /**
   * The client for a persisted gate record. The live connection from this
   * observer pass wins; otherwise the connection is looked back up from the
   * factory the gate was created under, falling back to the deployment client
   * (single-project wiring, or a factory that has since been disconnected).
   */
  private async clientForRecord(record: GateRecord, conn: ResolvedConnection | null): Promise<HitlyClientLike> {
    if (conn) return this.clientFor(conn)
    const factoryProjectId = record.factoryProjectId
    if (this.options.registry && factoryProjectId) {
      const found = await this.options.registry.resolveByFactoryProjectId(factoryProjectId).catch(() => null)
      if (found) return this.clientFor(found)
    }
    return this.options.client
  }

  private decisionChannel(gate: Gate, sessionId: string, toolCallId: string): string {
    try {
      return this.options.resolveFactoryDecisionChannel?.({ gate, sessionId, toolCallId }) ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  diagnostics(): Record<string, unknown> {
    return {
      id: this.id,
      gates: { ...this.gates },
      mergeAfterAccept: this.mergeAfterAccept,
      hitlyBaseUrl: this.options.config.hitlyBaseUrl,
      openApprovals: this.openApprovals.size,
      queuedObserverPasses: this.observerQueue.size,
    }
  }

  /**
   * One reconciliation pass: refresh gate config from HITLy (fail-closed),
   * then walk every open approval through the SAME applyDecision matrix as
   * the resume route. Called by the Factory worker; safe to call ad hoc.
   */
  async reconcileNow(): Promise<{
    checked: number
    applied: number
    errors: number
    conflicts: number
    configRefreshed: boolean
  }> {
    if (this.options.registry) return this.reconcilePerConnection()
    // After a Factory restart the in-process open set is empty; re-seed it
    // from HITLy's open list (pending + failed_resume rows, whose callbacks
    // exhausted HITLy's ~1s retries) once, so decisions made while we were
    // down still converge.
    if (!this.seededFromHitly && this.options.client.listPending) {
      this.seededFromHitly = true
      try {
        const pending = await this.options.client.listPending()
        for (const approval of pending) {
          const gate = approval.metadata[METADATA_KEYS.gate]
          if (typeof gate !== 'string' || !VALID_GATES.includes(gate as Gate)) continue
          if (typeof approval.metadata[METADATA_KEYS.sessionId] !== 'string') continue
          if (this.openApprovals.has(this.openKey(undefined, approval.id))) continue
          this.openApprovals.set(this.openKey(undefined, approval.id), { approvalId: approval.id, gate: gate as Gate, metadata: approval.metadata })
        }
      } catch (error) {
        this.seededFromHitly = false
        this.options.log?.('warn', 'hitly reconcile: seeding from pending list failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.reconciler ??= new HitlyReconciler({
      listOpen: () => [...this.openApprovals.values()],
      closeOpen: (approvalId) => {
        this.openApprovals.delete(this.openKey(undefined, approvalId))
        this.cbAuthTokens.delete(approvalId)
      },
      getApproval: async (approvalId) => {
        if (!this.options.client.getApproval) throw Object.assign(new Error('no approval read path'), { status: 502 })
        return this.options.client.getApproval(approvalId)
      },
      refreshConfig: this.options.client.getIntegrationConfig
        ? async () => {
            const remote = await this.options.client.getIntegrationConfig!()
            this.updateRemoteConfig(remote)
          }
        : undefined,
      apply: (snapshot) => applyDecision(snapshot, this.buildApplyDeps()),
      gateStore: this.gateStore,
      cancelApproval: this.options.client.cancelApproval
        ? async (approvalId, reason) => {
            await this.options.client.cancelApproval!(approvalId, reason)
          }
        : undefined,
      annotateApproval: this.options.client.annotateApproval
        ? async (approvalId, note) => this.options.client.annotateApproval!(approvalId, note)
        : undefined,
      ackResume: this.options.client.ackResume
        ? async (approvalId) => {
            await this.options.client.ackResume!(approvalId)
          }
        : undefined,
      log: this.options.log,
    })
    return this.reconciler.tick()
  }

  /**
   * Registry-mode reconciliation (#211): every connected factory is polled
   * through ITS OWN credentials — listPending, approval reads, gate config,
   * and resume-ack all go to that factory's HITLy project. One unreachable
   * HITLy server slows only its own connections; the pass keeps going and
   * records the failure on that connection's status.
   */
  private async reconcilePerConnection(): Promise<{ checked: number; applied: number; errors: number; conflicts: number; configRefreshed: boolean }> {
    const registry = this.options.registry!
    const totals = { checked: 0, applied: 0, errors: 0, conflicts: 0, configRefreshed: true }
    for (const conn of await registry.listAll()) {
      const client = registry.clientFor(conn)
      const prefix = this.openKeyPrefix(conn)
      if (!this.seededConnections.has(prefix) && client.listPending) {
        this.seededConnections.add(prefix)
        try {
          const pending = await client.listPending()
          for (const approval of pending) {
            const gate = approval.metadata[METADATA_KEYS.gate]
            if (typeof gate !== 'string' || !VALID_GATES.includes(gate as Gate)) continue
            if (typeof approval.metadata[METADATA_KEYS.sessionId] !== 'string') continue
            if (this.openApprovals.has(`${prefix}${approval.id}`)) continue
            this.openApprovals.set(`${prefix}${approval.id}`, {
              approvalId: approval.id,
              gate: gate as Gate,
              metadata: approval.metadata,
            })
          }
        } catch (error) {
          this.seededConnections.delete(prefix)
          totals.errors += 1
          this.options.log?.('warn', 'hitly reconcile: seeding from pending list failed', {
            factoryProjectId: conn.factoryProjectId,
            error: error instanceof Error ? error.message : String(error),
          })
          await registry
            .recordError(conn.orgId, conn.factoryProjectId, error instanceof Error ? error.message : String(error))
            .catch(() => {})
        }
      }
      const reconciler = new HitlyReconciler({
        listOpen: () =>
          [...this.openApprovals.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([, entry]) => entry),
        closeOpen: (approvalId) => {
          this.openApprovals.delete(`${prefix}${approvalId}`)
          this.cbAuthTokens.delete(approvalId)
        },
        getApproval: async (approvalId) => {
          if (!client.getApproval) throw Object.assign(new Error('no approval read path'), { status: 502 })
          return client.getApproval(approvalId)
        },
        refreshConfig: client.getIntegrationConfig
          ? async () => {
              const remote = await client.getIntegrationConfig!()
              await registry.updateRemoteState(conn.orgId, conn.factoryProjectId, {
                gates: remote.gates,
                mergeAfterAccept: remote.mergeAfterAccept,
              })
            }
          : undefined,
        apply: async (snapshot) => applyDecision(snapshot, await this.buildApplyDepsFor(snapshot)),
        gateStore: this.gateStore,
        // The factory's own credentials close its own items.
        cancelApproval: client.cancelApproval
          ? async (approvalId, reason) => {
              await client.cancelApproval!(approvalId, reason)
            }
          : undefined,
        annotateApproval: client.annotateApproval
          ? async (approvalId, note) => client.annotateApproval!(approvalId, note)
          : undefined,
        ackResume: client.ackResume
          ? async (approvalId) => {
              await client.ackResume!(approvalId)
            }
          : undefined,
        log: this.options.log,
      })
      try {
        const result = await reconciler.tick()
        totals.checked += result.checked
        totals.applied += result.applied
        totals.errors += result.errors
        totals.conflicts += result.conflicts
        if (client.getIntegrationConfig && !result.configRefreshed) totals.configRefreshed = false
        if (result.errors > 0) {
          await registry
            .recordError(conn.orgId, conn.factoryProjectId, `reconcile: ${result.errors} error(s) on last pass`)
            .catch(() => {})
        }
      } catch (error) {
        totals.errors += 1
        this.options.log?.('warn', 'hitly reconcile: connection pass failed', {
          factoryProjectId: conn.factoryProjectId,
          error: error instanceof Error ? error.message : String(error),
        })
        await registry
          .recordError(conn.orgId, conn.factoryProjectId, error instanceof Error ? error.message : String(error))
          .catch(() => {})
      }
    }
    return totals
  }

  /**
   * openApprovals are keyed by connection scope: two HITLy projects on
   * different HITLy servers can hand out the same approval id, so the
   * reconcile pass must never confuse them.
   */
  private openKey(conn: ResolvedConnection | null | undefined, approvalId: string): string {
    return `${conn?.orgId ?? 'default'}|${conn?.factoryProjectId ?? 'default'}|${approvalId}`
  }

  private openKeyPrefix(conn: ResolvedConnection): string {
    return `${conn.orgId}|${conn.factoryProjectId}|`
  }

  /**
   * Apply deps for a resolved snapshot. In registry mode the factory's own
   * connection carries its gate switches and merge preference (HITLy project
   * config wins via the reconcile refresh); otherwise the deployment config.
   */
  private async buildApplyDepsFor(snapshot: ApprovalSnapshot): Promise<ApplyDeps> {
    if (this.options.registry && snapshot.factoryProjectId) {
      const conn = await this.options.registry.resolveByFactoryProjectId(snapshot.factoryProjectId)
      if (conn) {
        const gateOverrides = this.options.gateOverrides ?? {}
        return this.buildApplyDeps({
          gates: { ...conn.config.gates, ...gateOverrides },
          mergeAfterAccept: conn.config.mergeAfterAccept,
        })
      }
    }
    return this.buildApplyDeps()
  }

  /** Shared apply wiring — reused by the resume route and the reconciliation worker. */
  buildApplyDeps(overrides?: { gates?: Record<Gate, boolean>; mergeAfterAccept?: boolean }): ApplyDeps {
    return {
      gates: overrides?.gates ?? this.gates,
      mergeAfterAccept: overrides?.mergeAfterAccept ?? this.mergeAfterAccept,
      gateStore: this.gateStore,
      answerParked: async (args) => {
        if (!this.options.applySeams) throw new Error('hitly: applySeams.answerParked not wired')
        return this.options.applySeams.answerParked(args)
      },
      signalSession: async (args) => {
        if (!this.options.applySeams) throw new Error('hitly: applySeams.signalSession not wired')
        return this.options.applySeams.signalSession(args)
      },
      markMergeReady: this.options.markMergeReady ?? (async () => {}),
      attemptMerge: this.options.attemptMerge ?? (async () => ({ merged: false, reason: 'merge not configured' })),
      recordEvent: async () => {},
      alreadyApplied: async (key) => this.appliedDecisions.has(key),
      markApplied: async (key) => {
        this.appliedDecisions.add(key)
      },
    }
  }

  private remember(store: Map<string, number>, key: string): void {
    const now = Date.now()
    store.set(key, now)
    if (store.size > SEEN_MAX) {
      for (const [k, ts] of store) {
        if (now - ts > SEEN_TTL_MS) store.delete(k)
      }
      while (store.size > SEEN_MAX) {
        const oldest = store.keys().next().value
        if (oldest === undefined) break
        store.delete(oldest)
      }
    }
  }
}
