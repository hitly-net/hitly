import { buildApprovalRequest, detectGate, METADATA_KEYS, RESUME_PATH, type HitlyClientLike } from './gates.ts'
import { handleResumeRequest, type ResumeDeps } from './resume.ts'
import { applyDecision, type ApplyDeps } from './apply.ts'
import { HitlyReconciler, type OpenApproval } from './worker.ts'
import type { ApprovalSnapshot, Gate, PluginRuntimeConfig } from './types.ts'

export { DEFAULT_POLL_INTERVAL_MS, parseRuntimeConfig } from './config.ts'

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
  config: PluginRuntimeConfig
  client: HitlyClientLike & {
    getApproval?(
      id: string,
    ): Promise<{
      id: string
      status: string
      decision: string | null
      metadata: Record<string, unknown>
      reason?: string
      editedArgs?: Record<string, unknown>
      response?: string
      answer?: string
    }>
    getIntegrationConfig?(): Promise<{ gates: Record<Gate, boolean>; mergeAfterAccept: boolean }>
    /** Restart re-adoption feed: open gate approvals (pending + failed_resume) with create-time metadata. */
    listPending?(): Promise<Array<{ id: string; status: string; decision: string | null; metadata: Record<string, unknown> }>>
    /** Host receipt that a failed_resume decision was converged; settles the row to decided. */
    ackResume?(approvalId: string): Promise<void>
  }
  seams: SessionTargetSeams
  applySeams?: ApplySeams
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
  private readonly seenToolCalls = new Map<string, number>()
  private readonly seenEvents = new Map<string, number>()
  private readonly appliedDecisions = new Set<string>()
  private readonly openApprovals = new Map<string, OpenApproval>()
  private seededFromHitly = false
  private reconciler?: HitlyReconciler

  constructor(options: HitlyPluginOptions) {
    this.options = options
    this.gates = { ...options.config.gates, ...(options.gateOverrides ?? {}) }
    this.mergeAfterAccept = options.mergeAfterAcceptOverride ?? options.config.mergeAfterAccept
  }

  /** Refresh gate state from HITLy (source of truth). Fail-closed: never called with stale/failed reads. */
  updateRemoteConfig(remote: { gates: Record<Gate, boolean>; mergeAfterAccept: boolean }): void {
    this.gates = { ...remote.gates }
    this.mergeAfterAccept = remote.mergeAfterAccept
  }

  routes(_ctx: unknown): Array<{ path: string; method: 'POST'; requiresAuth: boolean; handler: (context: unknown) => Promise<Response> }> {
    return [
      {
        path: RESUME_PATH,
        method: 'POST',
        // HITLy posts with its own bearer + HMAC signature — it has no
        // Factory interactive auth, and the signature IS the credential.
        requiresAuth: false,
        handler: (context: unknown) => this.handleResume(rawRequestFrom(context)),
      },
    ]
  }

  private async handleResume(request: Request): Promise<Response> {
    const rawBody = await request.text()
    const deps: ResumeDeps = {
      dedupe: {
        check: (eventId) => this.seenEvents.has(eventId),
        remember: (eventId) => this.remember(this.seenEvents, eventId),
      },
      fetchApprovalState: async (approvalId) => {
        if (!this.options.client.getApproval) throw Object.assign(new Error('no approval read path'), { status: 502 })
        return this.options.client.getApproval(approvalId)
      },
      apply: (cmd) => this.dispatchApply(cmd),
      log: this.options.log,
    }
    return handleResumeRequest({ headers: request.headers, rawBody, config: this.options.config, deps })
  }

  private async dispatchApply(cmd: import('./resume.ts').ResumeDispatch) {
    const snapshot = snapshotFromDispatch(cmd)
    if (!snapshot) return { applied: false, reason: 'unknown gate' }
    const deps = this.buildApplyDeps()
    return applyDecision(snapshot, deps)
  }

  async postToolObserver(args: { toolContext: { toolName: string; input: unknown; output?: unknown; error?: unknown; toolCallId?: string; context: unknown }; requestContext?: unknown }): Promise<void> {
    try {
      const toolContext = args.toolContext
      if (!toolContext || toolContext.error) return
      const gate = detectGate(toolContext.toolName, this.gates)
      if (!gate) return
      const session = this.options.seams.resolveSessionTarget(args.requestContext)
      if (!session) {
        this.options.log?.('warn', 'hitly: gate tool call without resolvable session', { toolName: toolContext.toolName })
        return
      }
      const toolCallId = typeof toolContext.toolCallId === 'string' && toolContext.toolCallId ? toolContext.toolCallId : 'unknown'
      const dedupeKey = `${session.sessionId}:${toolCallId}:${gate}`
      if (this.seenToolCalls.has(dedupeKey)) return
      this.remember(this.seenToolCalls, dedupeKey)

      const pr = gate === 'review' ? extractPr(toolContext.output) : undefined
      const request = buildApprovalRequest({
        gate,
        toolCallId,
        session,
        input: toolContext.input,
        output: toolContext.output,
        pr,
        config: this.options.config,
      })
      void Promise.resolve(
        this.options.client.createApproval(request as unknown as Record<string, unknown>, request.idempotencyKey!),
      ).then(
        (ref) => {
          this.openApprovals.set(ref.id, {
            approvalId: ref.id,
            gate,
            metadata: (request.metadata ?? {}) as Record<string, unknown>,
          })
          this.options.log?.('info', 'hitly: gate approval opened', { gate, approvalId: ref.id, sessionId: session.sessionId })
        },
        (error: unknown) => {
          // Do NOT keep the dedupe entry: allow a later observation (or the
          // reconciliation worker) to retry. HITLy create-once keeps retries safe.
          this.seenToolCalls.delete(dedupeKey)
          this.options.log?.('error', 'hitly: failed to open gate approval', {
            gate,
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
    } catch (error) {
      // Never throw into the Factory tool pipeline.
      this.options.log?.('error', 'hitly: postToolObserver failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  diagnostics(): Record<string, unknown> {
    return {
      id: this.id,
      gates: { ...this.gates },
      mergeAfterAccept: this.mergeAfterAccept,
      hitlyBaseUrl: this.options.config.hitlyBaseUrl,
      openToolCallKeys: this.seenToolCalls.size,
      openApprovals: this.openApprovals.size,
    }
  }

  /**
   * One reconciliation pass: refresh gate config from HITLy (fail-closed),
   * then walk every open approval through the SAME applyDecision matrix as
   * the resume route. Called by the Factory worker; safe to call ad hoc.
   */
  async reconcileNow(): Promise<{ checked: number; applied: number; errors: number; configRefreshed: boolean }> {
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
          if (this.openApprovals.has(approval.id)) continue
          this.openApprovals.set(approval.id, { approvalId: approval.id, gate: gate as Gate, metadata: approval.metadata })
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
        this.openApprovals.delete(approvalId)
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
      ackResume: this.options.client.ackResume
        ? async (approvalId) => {
            await this.options.client.ackResume!(approvalId)
          }
        : undefined,
      log: this.options.log,
    })
    return this.reconciler.tick()
  }

  /** Shared apply wiring — reused by the resume route and the reconciliation worker. */
  buildApplyDeps(): ApplyDeps {
    return {
      gates: this.gates,
      mergeAfterAccept: this.mergeAfterAccept,
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
