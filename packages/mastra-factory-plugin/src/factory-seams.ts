/**
 * factory-seams — the ONLY module in this package with runtime `@mastra/*`
 * imports. Every upstream touchpoint lives here so a Factory upgrade is a
 * one-file audit (docs/SPIKE.md). index.ts and ./server stay @mastra-free.
 */
import { MastraWorker } from '@mastra/core/worker'
import { getFactoryAuthOrgId, getFactoryAuthUserFromContext, getFactoryAuthUserId } from '@mastra/factory/auth'
import { answerParkedCall } from '@mastra/factory/tools/approval-tools'
import { deliverFactorySessionNotification, resolveSessionThread } from '@mastra/factory/tools/deliver'
import type { FactoryIntegration, IntegrationContext } from '@mastra/factory/integrations/base'
import type { ApplySeams, HitlyPluginOptions, SessionTargetSeams } from './index.ts'
import { HitlyMastraFactoryPlugin } from './index.ts'
import { createMemoryGateStateStore, type GateRecord, type GateStateStore } from './gate-state.ts'
import { HitlyClient } from './hitly-client.ts'
import { attemptSquashMerge, createGitHubApi, parsePrUrl } from './merge.ts'
import {
  HitlyConnectionRegistry,
  type ConnectionDirectory,
  type ConnectionSettingsStore,
  type EnvFallback,
  type FactoryProjectLister,
} from './connections.ts'

type RequestContext = { get(key: string): unknown }

/**
 * Extract the session identity from a tool-execution RequestContext,
 * mirroring the host's own session-subscriptions resolution: the mounted
 * controller carries threadId/sessionId/state; org+user come from the
 * factory auth normalizers (NOT a raw requestContext.get('user')).
 */
export function resolveSessionTarget(requestContext: unknown): {
  sessionId: string
  threadId?: string
  orgId?: string
  userId?: string
  factoryProjectId?: string
} | null {
  try {
    const rc = requestContext as RequestContext
    const controller = rc.get('controller') as
      | { getState?(): { factoryProjectId?: string }; threadId?: string; sessionId?: string }
      | undefined
    const authUser = getFactoryAuthUserFromContext(rc as never)
    const orgId = getFactoryAuthOrgId(authUser)
    const userId = getFactoryAuthUserId(authUser)
    const factoryProjectId = controller?.getState?.().factoryProjectId
    const sessionId = controller?.sessionId
    if (!sessionId || !controller?.threadId || !factoryProjectId || !orgId || !userId) return null
    return { sessionId, threadId: controller.threadId, orgId, userId, factoryProjectId }
  } catch {
    return null
  }
}

export const sessionTargetSeams: SessionTargetSeams = { resolveSessionTarget }

/** Late-bound host context: MastraFactory supplies IntegrationContext at prepare time. */
export interface HostContextRef {
  current: IntegrationContext | undefined
}

/** The subset of the Factory integration-subscription surface the gate store uses. */
interface SubscriptionRow {
  id: string
  orgId?: string
  data: unknown
  updatedAt?: Date
}

interface SubscriptionHandle {
  create(input: {
    orgId: string
    targetKey: string
    sessionId?: string | null
    status?: string
    data: unknown
  }): Promise<unknown>
  listByTarget(targetKey: string, opts?: { status?: string }): Promise<SubscriptionRow[]>
  delete(id: string): Promise<boolean>
}

const GATE_TARGET_PREFIX = 'hitly-gate:'

/**
 * Durable gate store over the host's generic integration storage
 * (`subscriptions` namespace), with an in-process memory layer in front.
 *
 * The subscriptions row keeps the gate state machine in `status` (queryable)
 * and the full record in `data`. `data` cannot be updated in place, so a save
 * writes the new row first and only then removes the older ones: a crash
 * between the two leaves duplicates that read as the newest row, never a
 * gap. Storage failures degrade to memory-only — gate tracking must never
 * take the tool pipeline or a resume callback down with it.
 */
export function createSubscriptionGateStateStore(
  ref: HostContextRef,
  log?: (level: string, message: string, meta?: Record<string, unknown>) => void,
): GateStateStore {
  const memory = createMemoryGateStateStore()

  function handle(): SubscriptionHandle | null {
    const storage = ref.current?.storage as { generic?: { subscriptions?: unknown } } | undefined
    return (storage?.generic?.subscriptions as SubscriptionHandle | undefined) ?? null
  }

  return {
    async load(key: string): Promise<GateRecord | null> {
      const local = await memory.load(key)
      if (local) return local
      const subscriptions = handle()
      if (!subscriptions) return null
      try {
        const rows = await subscriptions.listByTarget(`${GATE_TARGET_PREFIX}${key}`)
        let best: SubscriptionRow | undefined
        for (const row of rows) {
          if (!best || (row.updatedAt && best.updatedAt && row.updatedAt > best.updatedAt)) best = row
        }
        const record = best?.data as GateRecord | undefined
        if (!record || record.key !== key) return null
        await memory.save(record)
        return record
      } catch (error) {
        log?.('warn', 'hitly gate store: durable read failed, using memory only', {
          key,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    },

    async save(record: GateRecord): Promise<void> {
      await memory.save(record)
      const subscriptions = handle()
      if (!subscriptions) return
      const targetKey = `${GATE_TARGET_PREFIX}${record.key}`
      try {
        const existing = await subscriptions.listByTarget(targetKey)
        // The org normally rides on the record itself. It does not when the
        // gate was opened before the session's org was known, or when a
        // snapshot from HITLy arrives without one — and the `hitly_applied` /
        // `conflict` saves are exactly those. Fall back to the org of the row
        // this save replaces, so a gate that was durable once stays durable.
        const orgId = record.orgId ?? existing[0]?.orgId
        if (!orgId) {
          log?.(record.status === 'open' ? 'debug' : 'warn', 'hitly gate store: no org for record, not persisted', {
            key: record.key,
            status: record.status,
          })
          return
        }
        await subscriptions.create({
          orgId,
          targetKey,
          sessionId: record.sessionId,
          status: record.status,
          data: record,
        })
        for (const row of existing) await subscriptions.delete(row.id)
      } catch (error) {
        log?.('warn', 'hitly gate store: durable write failed, memory only until the next save', {
          key: record.key,
          status: record.status,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

export function createApplySeams(ref: HostContextRef): ApplySeams {
  function requireController() {
    const controller = ref.current?.controller
    if (!controller) throw new Error('hitly: Factory host context not bound yet (IntegrationContext.controller missing)')
    return controller
  }
  return {
    async answerParked(args) {
      const controller = requireController()
      // `declineReason` is required by the seam even for approvals.
      await answerParkedCall(
        { messaging: async () => ({ controller }) } as never,
        {
          session: { sessionId: args.sessionId, userId: args.userId ?? '', orgId: args.orgId ?? '' },
          toolCallId: args.toolCallId,
          decision: args.decision,
          declineReason: args.reason,
        },
      )
    },
    async signalSession(args) {
      const controller = requireController()
      const context = ref.current
      // Factory's own call sites bind `sessions` to the source-control storage
      // domain and `runs` to the work-item domain (see tools/messaging-tools).
      const sessions = context?.storage.sourceControl as never
      const runs = context?.workItems as never
      let threadId = args.threadId
      if (!threadId) {
        threadId = (await resolveSessionThread({ controller, sessions, workItems: runs, sessionId: args.sessionId } as never)) ?? undefined
      }
      if (!threadId) {
        // Without a resolvable thread there is nowhere to deliver the human's
        // words. Fail loudly — the reconciler retries; never drop silently.
        throw new Error(`hitly: no resolvable thread for session ${args.sessionId}`)
      }
      const result = await deliverFactorySessionNotification({
        controller,
        sessions,
        runs,
        target: { sessionId: args.sessionId, threadId },
        notification: {
          kind: 'message',
          priority: 'high',
          summary: 'HITLy decision',
          payload: { message: args.message },
          sourceId: 'hitly-mastra-factory',
        },
      } as never)
      if (result.delivered === 'skipped') {
        throw new Error(`hitly: session signal skipped (${result.reason ?? 'unknown'})`)
      }
    },
  }
}

/** Reconciliation worker: polls HITLy so lost callbacks still converge. */
export class HitlyReconcileWorker extends MastraWorker {
  readonly name = 'hitly-reconcile'
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false

  constructor(
    private readonly integration: HitlyMastraFactoryPlugin,
    private readonly intervalMs: number,
    private readonly log?: (level: string, message: string, meta?: Record<string, unknown>) => void,
  ) {
    super()
  }

  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    const tick = () => {
      void this.integration.reconcileNow().catch((error: unknown) => {
        this.log?.('error', 'hitly reconcile tick failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }
    this.#timer = setInterval(tick, this.intervalMs)
    // don't hold the process open solely for reconciliation
    this.#timer.unref?.()
    tick()
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  get isRunning(): boolean {
    return this.#running
  }
}

export interface HitlyIntegrationOptions extends Omit<HitlyPluginOptions, 'seams' | 'applySeams' | 'client'> {
  /** Override in tests; defaults to a real HitlyClient built from the parsed config. */
  client?: HitlyPluginOptions['client']
  /** Override in tests; defaults to the real host-context-backed seams. */
  seams?: SessionTargetSeams
  applySeams?: ApplySeams
  /**
   * Parsed HITLY_ENV_FALLBACK. With no explicit `registry`, factories in
   * this set fall back to the env credentials when they have no saved
   * connection; default `{ mode: 'none' }` (connections come only from the
   * per-factory settings surface).
   */
  envFallback?: EnvFallback
}

/** What the registry needs, however the host happens to hand it over. */
interface RegistryParts {
  settings?: ConnectionSettingsStore
  subscriptions?: ConnectionDirectory
  projects?: FactoryProjectLister
}

/**
 * The storage slice the connection registry needs, matched structurally
 * against IntegrationContext.
 *
 * On @mastra/factory 0.30.0 (and 0.31.0) `IntegrationContext.storage.generic`
 * IS the integration's scoped handle — `settings` and `subscriptions` sit on
 * it directly. `forIntegration` belongs to the `IntegrationStorage` domain
 * class, which the host never passes to an integration, so reading only
 * through it silently disabled the whole per-factory feature
 * (hitly-net/hitly#218). It stays as a fallback in case a host does expose a
 * scoping factory.
 */
interface IntegrationStorageSlice {
  storage?: {
    generic?: {
      settings?: ConnectionSettingsStore
      subscriptions?: ConnectionDirectory
      forIntegration?(id: string): { settings?: ConnectionSettingsStore; subscriptions?: ConnectionDirectory }
    }
    projects?: FactoryProjectLister
  }
}

/** The `initialize({ storage, projects, … })` arguments, narrowed structurally. */
interface InitializeArgsSlice {
  storage?: { settings?: ConnectionSettingsStore; subscriptions?: ConnectionDirectory }
  projects?: FactoryProjectLister
}

function registryFromParts(
  parts: RegistryParts,
  options: HitlyIntegrationOptions,
): HitlyConnectionRegistry | null {
  if (!parts.settings || !parts.subscriptions || !parts.projects) return null
  return new HitlyConnectionRegistry({
    settings: parts.settings,
    directory: parts.subscriptions,
    projects: parts.projects,
    envConfig: options.config,
    envFallback: options.envFallback ?? { mode: 'none' },
    log: options.log,
  })
}

/** Log the precise reason a registry could not be built, so the next host-shape drift is diagnosable from boot output. */
function reportMissingParts(parts: RegistryParts, options: HitlyIntegrationOptions, origin: string): void {
  const missing = [
    !parts.settings ? 'settings' : undefined,
    !parts.subscriptions ? 'subscriptions' : undefined,
    !parts.projects ? 'projects' : undefined,
  ].filter((name): name is string => Boolean(name))
  options.log?.(
    'warn',
    `hitly: host integration storage incomplete (${missing.join(', ')} missing from ${origin}) — per-factory connections and the settings page are disabled`,
  )
}

function buildRegistryFromContext(
  ctx: IntegrationContext,
  options: HitlyIntegrationOptions,
): HitlyConnectionRegistry | null {
  const slice = ctx as IntegrationContext & IntegrationStorageSlice
  const generic = slice.storage?.generic
  // Prefer the handle the host actually hands us; only scope through
  // forIntegration when the direct members are absent.
  const scoped =
    generic?.settings && generic?.subscriptions ? generic : generic?.forIntegration?.('hitly')
  const parts: RegistryParts = {
    settings: scoped?.settings,
    subscriptions: scoped?.subscriptions,
    projects: slice.storage?.projects,
  }
  const registry = registryFromParts(parts, options)
  if (!registry) reportMissingParts(parts, options, 'IntegrationContext.storage')
  return registry
}

/**
 * The class a Factory host registers:
 *
 *   const integration = createHitlyIntegration({ config, client })
 *   new MastraFactory({ integrations: [integration] })
 *
 * Binds the IntegrationContext (for controller/workers) and keeps the
 * structural FactoryIntegration conformance check inside this module.
 */
export function createHitlyIntegration(options: HitlyIntegrationOptions): HitlyMastraFactoryPlugin & FactoryIntegration {
  const hostRef: HostContextRef = { current: undefined }
  const seams = options.seams ?? sessionTargetSeams
  const applySeams = options.applySeams ?? createApplySeams(hostRef)
  const client = options.client ?? new HitlyClient({
    hitlyBaseUrl: options.config.hitlyBaseUrl,
    hitlyApiKey: options.config.hitlyApiKey,
    projectId: options.config.projectId,
  })
  // Default merge authority: GitHub REST squash, gated upstream on the
  // HITLy-accepted review verdict + mergeAfterAccept. No token → refuse with
  // zero API calls (merge-ready recorded only).
  const attemptMerge =
    options.attemptMerge ??
    (async (args: { prUrl?: string; headSha?: string }) => {
      if (!args.prUrl) return { merged: false, reason: 'no pull request url recorded on the review' }
      const pr = parsePrUrl(args.prUrl)
      if (!pr) return { merged: false, reason: `not a GitHub pull request url: ${args.prUrl}` }
      const token = options.config.githubToken
      return attemptSquashMerge({ api: createGitHubApi(token ?? ''), pr, expectedHeadSha: args.headSha, token })
    })
  const integration = new HitlyMastraFactoryPlugin({
    ...options,
    client,
    seams,
    applySeams,
    attemptMerge,
    // Durable by default: gate state survives a restart through the host's
    // integration storage, with a memory layer in front.
    gateStore: options.gateStore ?? createSubscriptionGateStateStore(hostRef, options.log),
  })

  const bind = integration as HitlyMastraFactoryPlugin & {
    initialize?(args: unknown): void | Promise<void>
    workers?(ctx: unknown): MastraWorker[]
  }
  // Host storage backs per-factory connections, and it arrives twice: at
  // prepare() through initialize({ storage, projects }) and again with the
  // IntegrationContext at routes()/workers(). Bind from whichever comes first;
  // attachRegistry is itself first-wins, so a caller-supplied registry survives.
  let registryAttempted = false
  const bindRegistry = (registry: HitlyConnectionRegistry | null): boolean => {
    if (!registry) return false
    registryAttempted = true
    integration.attachRegistry(registry)
    options.log?.('info', 'hitly: per-factory connections enabled (registry bound to host integration storage)')
    return true
  }
  bind.initialize = async (args: unknown) => {
    if (registryAttempted || options.registry) return
    const initArgs = (args ?? {}) as InitializeArgsSlice
    // A handle that is unusable here is not a failure: leave the registry
    // unattempted so the IntegrationContext path still gets its own chance.
    bindRegistry(
      registryFromParts(
        {
          settings: initArgs.storage?.settings,
          subscriptions: initArgs.storage?.subscriptions,
          projects: initArgs.projects,
        },
        options,
      ),
    )
  }
  const ensureRegistry = (ctx: IntegrationContext) => {
    hostRef.current = ctx
    if (registryAttempted || options.registry) return
    if (bindRegistry(buildRegistryFromContext(ctx, options))) return
    registryAttempted = true
  }
  const originalRoutes = integration.routes.bind(integration)
  integration.routes = (ctx: IntegrationContext) => {
    ensureRegistry(ctx)
    return originalRoutes(ctx)
  }
  bind.workers = (ctx: IntegrationContext) => {
    ensureRegistry(ctx)
    return [new HitlyReconcileWorker(integration, options.config.pollIntervalMs, options.log)]
  }

  // Structural conformance to FactoryIntegration is checked here, at compile
  // time, against the real upstream type (this is the only module that
  // imports it). A missing/renamed required member fails the build — the
  // plugin must never silently stop being an integration.
  const conforming: FactoryIntegration = integration
  return conforming as HitlyMastraFactoryPlugin & FactoryIntegration
}
