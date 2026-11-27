import { HitlyClient, type HitlyClientConfig } from './hitly-client.ts'
import type { HitlyClientLike } from './gates.ts'
import type { Gate, PluginRuntimeConfig } from './types.ts'

/**
 * Per-factory HITLy connections (#211).
 *
 * Storage model (IntegrationStorageHandle, all @mastra/*-free behind narrow
 * interfaces so this module unit-tests with fakes):
 *  - Secrets + status: `settings` rows keyed (orgId, `factory:<fpid>`),
 *    encrypted at rest by Factory's FactorySecretEncryption. No enumerate
 *    API exists on settings.
 *  - Reverse lookup (`factoryProjectId → orgId` for resume callbacks and
 *    the reconcile worker): a non-secret directory row in `subscriptions`
 *    (targetKey `hitly:factory:<fpid>`). Subscriptions are NOT encrypted —
 *    never store secrets there (asserted by tests).
 *  - Enumeration: projects.listAll() joined with settings rows.
 */

export const SETTINGS_USER_PREFIX = 'factory:'
export const DIRECTORY_TARGET_PREFIX = 'hitly:factory:'

export function settingsUserIdFor(factoryProjectId: string): string {
  return `${SETTINGS_USER_PREFIX}${factoryProjectId}`
}

export function directoryTargetKeyFor(factoryProjectId: string): string {
  return `${DIRECTORY_TARGET_PREFIX}${factoryProjectId}`
}

/** Encrypted settings document for one factory. `connected:false` is the disconnect tombstone. */
export interface HitlyFactoryConnection {
  connected: boolean
  hitlyBaseUrl: string
  hitlyApiKey: string
  /** HITLy project id this factory asks in. */
  projectId: string
  /** Project webhook signing secret(s) HITLy uses to sign callbacks (rotation = overlap). */
  webhookSigningSecrets: string[]
  gates: Record<Gate, boolean>
  mergeAfterAccept: boolean
  connectedAt: string
  updatedAt: string
  lastCallbackAt?: string | null
  lastError?: string | null
}

/** Non-secret directory payload — subscription rows are stored unencrypted. */
export interface ConnectionDirectoryData {
  orgId: string
  factoryProjectId: string
  hitlyProjectId: string
  hitlyBaseUrl: string
  connectedAt: string
}

export interface ResolvedConnection {
  source: 'saved' | 'env'
  orgId: string
  factoryProjectId: string
  /** Full runtime config for gate creation and client construction. */
  config: PluginRuntimeConfig
  /** Saved status row for the settings UI/worker; env connections carry a derived row. */
  status: HitlyFactoryConnection
  factoryName?: string
}

export interface SaveConnectionInput {
  hitlyBaseUrl: string
  hitlyApiKey: string
  projectId: string
  webhookSigningSecret: string
  gates?: Partial<Record<Gate, boolean>>
  mergeAfterAccept?: boolean
}

// ---------------------------------------------------------------------------
// Narrow injected storage interfaces (mirrors IntegrationStorageHandle shapes)
// ---------------------------------------------------------------------------

export interface ConnectionSettingsStore {
  get(orgId: string, userId: string): Promise<HitlyFactoryConnection | null>
  save(orgId: string, userId: string, config: HitlyFactoryConnection): Promise<void>
}

export interface ConnectionDirectory {
  create(row: { orgId: string; targetKey: string; data: ConnectionDirectoryData }): Promise<{ id: string }>
  listByTarget(targetKey: string): Promise<Array<{ id: string; orgId: string }>>
  delete(id: string): Promise<unknown>
  deleteWhere(filter: { orgId: string; targetKey?: string }): Promise<unknown>
}

export interface FactoryProjectSummary {
  id: string
  orgId: string
  name?: string
}

export interface FactoryProjectLister {
  listAll(): Promise<FactoryProjectSummary[]>
}

export type EnvFallback = { mode: 'all' } | { mode: 'list'; factoryProjectIds: ReadonlySet<string> } | { mode: 'none' }

/** Parse HITLY_ENV_FALLBACK: `all`, a comma-separated factoryProjectId list, or unset/empty (none). */
export function parseEnvFallback(value: string | undefined): EnvFallback {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return { mode: 'none' }
  if (trimmed.toLowerCase() === 'all') return { mode: 'all' }
  const ids = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (ids.length === 0) return { mode: 'none' }
  return { mode: 'list', factoryProjectIds: new Set(ids) }
}

function envFallbackCovers(fallback: EnvFallback, factoryProjectId: string): boolean {
  if (fallback.mode === 'all') return true
  if (fallback.mode === 'list') return fallback.factoryProjectIds.has(factoryProjectId)
  return false
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!/^https?:\/\//.test(trimmed)) throw new Error('hitlyBaseUrl must be an absolute http(s) URL')
  return trimmed.replace(/\/+$/, '')
}

function defaultGates(): Record<Gate, boolean> {
  return { plan: true, review: true, ask_user: true }
}

export interface HitlyConnectionRegistryDeps {
  settings: ConnectionSettingsStore
  directory: ConnectionDirectory
  projects: FactoryProjectLister
  /** Deployment-level env config; used for env-fallback connections and shared publicBaseUrl. */
  envConfig: PluginRuntimeConfig | null
  envFallback: EnvFallback
  /** Injection point for tests / custom transports. Defaults to the real HitlyClient. */
  clientFactory?: (config: HitlyClientConfig) => HitlyClientLike
  log?(level: string, message: string, meta?: Record<string, unknown>): void
}

/**
 * Resolves, saves, and caches per-factory HITLy connections. The plugin
 * consults this for every gate creation, resume callback, and reconcile
 * tick; a factory with neither a saved connection nor env fallback gets
 * no HITLy gates at all.
 */
export class HitlyConnectionRegistry {
  private readonly deps: HitlyConnectionRegistryDeps
  private readonly clientFactory: (config: HitlyClientConfig) => HitlyClientLike
  /** fpid → cached client + the credential fingerprint it was built from. */
  private readonly clients = new Map<string, { fingerprint: string; client: HitlyClientLike }>()

  constructor(deps: HitlyConnectionRegistryDeps) {
    this.deps = deps
    this.clientFactory =
      deps.clientFactory ?? ((config) => new HitlyClient(config) as unknown as HitlyClientLike)
  }

  /** Saved connection wins over env fallback; neither → null (no HITLy gates). */
  async resolve(orgId: string, factoryProjectId: string): Promise<ResolvedConnection | null> {
    const saved = await this.deps.settings.get(orgId, settingsUserIdFor(factoryProjectId))
    if (saved && saved.connected) {
      return {
        source: 'saved',
        orgId,
        factoryProjectId,
        config: this.buildConfig(saved),
        status: saved,
      }
    }
    if (this.deps.envConfig && envFallbackCovers(this.deps.envFallback, factoryProjectId)) {
      return {
        source: 'env',
        orgId,
        factoryProjectId,
        config: this.deps.envConfig,
        status: this.envStatus(factoryProjectId),
      }
    }
    return null
  }

  /** Resume-route lookup: the URL carries only the factoryProjectId. */
  async resolveByFactoryProjectId(factoryProjectId: string): Promise<ResolvedConnection | null> {
    const rows = await this.deps.directory.listByTarget(directoryTargetKeyFor(factoryProjectId))
    for (const row of rows) {
      const conn = await this.resolve(row.orgId, factoryProjectId)
      if (conn && conn.source === 'saved') return conn
    }
    if (this.deps.envConfig && envFallbackCovers(this.deps.envFallback, factoryProjectId)) {
      const project = (await this.safeListAllProjects()).find((p) => p.id === factoryProjectId)
      return {
        source: 'env',
        orgId: project?.orgId ?? '',
        factoryProjectId,
        config: this.deps.envConfig,
        status: this.envStatus(factoryProjectId),
        factoryName: project?.name,
      }
    }
    return null
  }

  /** Persist (encrypted) connection + non-secret directory row; invalidates the client cache. */
  async save(orgId: string, userId: string, factoryProjectId: string, input: SaveConnectionInput): Promise<HitlyFactoryConnection> {
    const now = new Date().toISOString()
    const previous = await this.deps.settings.get(orgId, settingsUserIdFor(factoryProjectId))
    const connection: HitlyFactoryConnection = {
      connected: true,
      hitlyBaseUrl: normalizeBaseUrl(input.hitlyBaseUrl),
      hitlyApiKey: input.hitlyApiKey.trim(),
      projectId: input.projectId.trim(),
      webhookSigningSecrets: input.webhookSigningSecret
        .split(',')
        .map((secret) => secret.trim())
        .filter(Boolean),
      gates: { ...defaultGates(), ...(input.gates ?? {}) },
      mergeAfterAccept: input.mergeAfterAccept ?? false,
      connectedAt: previous?.connectedAt ?? now,
      updatedAt: now,
      lastCallbackAt: null,
      lastError: null,
    }
    if (!connection.hitlyApiKey) throw new Error('hitlyApiKey is required')
    if (!connection.projectId) throw new Error('projectId is required')
    if (connection.webhookSigningSecrets.length === 0) throw new Error('webhookSigningSecret is required')
    await this.deps.settings.save(orgId, settingsUserIdFor(factoryProjectId), connection)
    // Create-then-delete: a crash between the two writes leaves a duplicate
    // (harmless — both rows resolve to the same orgId) instead of NO row,
    // which would make the saved connection unresolvable by resume callbacks.
    const stale = await this.deps.directory.listByTarget(directoryTargetKeyFor(factoryProjectId))
    await this.deps.directory.create({
      orgId,
      targetKey: directoryTargetKeyFor(factoryProjectId),
      data: {
        orgId,
        factoryProjectId,
        hitlyProjectId: connection.projectId,
        hitlyBaseUrl: connection.hitlyBaseUrl,
        connectedAt: connection.connectedAt,
      },
    })
    for (const row of stale) await this.deps.directory.delete(row.id)
    this.clients.delete(factoryProjectId)
    this.deps.log?.('info', 'hitly: connection saved', { orgId, factoryProjectId, hitlyProjectId: connection.projectId })
    return connection
  }

  /** Tombstones the settings row and removes the directory row; new asks stop immediately. */
  async disconnect(orgId: string, factoryProjectId: string): Promise<void> {
    const previous = await this.deps.settings.get(orgId, settingsUserIdFor(factoryProjectId))
    const now = new Date().toISOString()
    await this.deps.settings.save(orgId, settingsUserIdFor(factoryProjectId), {
      ...(previous ?? {
        hitlyBaseUrl: '',
        hitlyApiKey: '',
        projectId: '',
        webhookSigningSecrets: [],
        gates: defaultGates(),
        mergeAfterAccept: false,
        connectedAt: now,
      }),
      connected: false,
      updatedAt: now,
    })
    await this.deps.directory.deleteWhere({ orgId, targetKey: directoryTargetKeyFor(factoryProjectId) })
    this.clients.delete(factoryProjectId)
    this.deps.log?.('info', 'hitly: connection disconnected', { orgId, factoryProjectId })
  }

  /** Everything the settings page and the reconcile worker iterate. */
  async listAll(): Promise<ResolvedConnection[]> {
    const out: ResolvedConnection[] = []
    const seen = new Set<string>()
    for (const project of await this.safeListAllProjects()) {
      seen.add(project.id)
      const conn = await this.resolve(project.orgId, project.id)
      if (conn) {
        conn.factoryName = project.name
        out.push(conn)
      }
    }
    // Env-fallback factories can exist without a settings row; covered above via
    // resolve(). A fallback list may also name project ids that no longer exist —
    // skip them: there is no session that could ever ask for them.
    void seen
    return out
  }

  /** Per-connection status write for resume callbacks (best-effort). */
  async touchCallback(orgId: string, factoryProjectId: string): Promise<void> {
    await this.patchStatus(orgId, factoryProjectId, { lastCallbackAt: new Date().toISOString(), lastError: null })
  }

  /** Per-connection status write for worker/callback failures (best-effort). */
  async recordError(orgId: string, factoryProjectId: string, error: string): Promise<void> {
    await this.patchStatus(orgId, factoryProjectId, { lastError: error.slice(0, 500) })
  }

  /** Update gate toggles / merge flag from HITLy (authoritative) or the settings UI. */
  async updateRemoteState(
    orgId: string,
    factoryProjectId: string,
    patch: Partial<Pick<HitlyFactoryConnection, 'gates' | 'mergeAfterAccept'>>,
  ): Promise<void> {
    await this.patchStatus(orgId, factoryProjectId, patch)
    this.clients.delete(factoryProjectId)
  }

  /** Cached per-factory HITLy client; re-built when credentials change (fingerprint). */
  clientFor(conn: ResolvedConnection): HitlyClientLike {
    const { hitlyBaseUrl, hitlyApiKey, projectId } = conn.config
    const fingerprint = `${hitlyBaseUrl}\u0000${hitlyApiKey}\u0000${projectId}`
    const cached = this.clients.get(conn.factoryProjectId)
    if (cached && cached.fingerprint === fingerprint) return cached.client
    const client = this.clientFactory({ hitlyBaseUrl, hitlyApiKey, projectId })
    this.clients.set(conn.factoryProjectId, { fingerprint, client })
    return client
  }

  /** Drop all cached clients (test/dev hook; save/disconnect evict individually). */
  clearClientCache(): void {
    this.clients.clear()
  }

  private async patchStatus(
    orgId: string,
    factoryProjectId: string,
    patch: Partial<HitlyFactoryConnection>,
  ): Promise<void> {
    const current = await this.deps.settings.get(orgId, settingsUserIdFor(factoryProjectId))
    if (!current || !current.connected) return
    await this.deps.settings.save(orgId, settingsUserIdFor(factoryProjectId), {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    })
  }

  private async safeListAllProjects(): Promise<FactoryProjectSummary[]> {
    try {
      return await this.deps.projects.listAll()
    } catch (error) {
      this.deps.log?.('error', 'hitly: project enumeration failed', { message: String(error) })
      return []
    }
  }

  private buildConfig(saved: HitlyFactoryConnection): PluginRuntimeConfig {
    const publicBaseUrl = this.deps.envConfig?.publicBaseUrl ?? ''
    const pollIntervalMs = this.deps.envConfig?.pollIntervalMs ?? 30000
    return {
      hitlyBaseUrl: saved.hitlyBaseUrl,
      hitlyApiKey: saved.hitlyApiKey,
      projectId: saved.projectId,
      publicBaseUrl,
      webhookSigningSecrets: saved.webhookSigningSecrets,
      gates: saved.gates,
      mergeAfterAccept: saved.mergeAfterAccept,
      githubToken: this.deps.envConfig?.githubToken,
      pollIntervalMs,
    }
  }

  private envStatus(factoryProjectId: string): HitlyFactoryConnection {
    const now = new Date().toISOString()
    return {
      connected: true,
      hitlyBaseUrl: this.deps.envConfig?.hitlyBaseUrl ?? '',
      hitlyApiKey: this.deps.envConfig?.hitlyApiKey ?? '',
      projectId: this.deps.envConfig?.projectId ?? '',
      webhookSigningSecrets: this.deps.envConfig?.webhookSigningSecrets ?? [],
      gates: this.deps.envConfig?.gates ?? defaultGates(),
      mergeAfterAccept: this.deps.envConfig?.mergeAfterAccept ?? false,
      connectedAt: now,
      updatedAt: now,
      lastCallbackAt: null,
      lastError: null,
    }
  }
}
