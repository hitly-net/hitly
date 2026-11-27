/**
 * Interim Factory Connections card registry (hitly-net/hitly#218).
 *
 * Upstream Factory has no plugin extension point for the Settings →
 * Connections screen yet (hitly-net/hitly#211 tracks it), so the plugin ships
 * a version-guarded patch that injects a small bootstrap into the built SPA.
 * That bootstrap renders whatever cards the server reports; the server
 * reports whatever plugins have registered here.
 *
 * The registry is deliberately GENERIC: HITLy is just the first card, and a
 * second plugin registers its own card with the same
 * {@link registerConnectionCard} call. Cards are looked up through a
 * `Symbol.for` key on `globalThis` so a duplicated module instance (two
 * copies of the package in one process, or the ESM/CJS double-load) still
 * sees one registry.
 *
 * Like index.ts and settings-routes.ts, this module MUST NOT import
 * @mastra/* — it is loaded inside the HITLy app process as well.
 */

/** Statuses the Connections card can show. Mirrors the copy in the injected bootstrap. */
export type ConnectionCardStatus = 'connected' | 'not-connected' | 'env-fallback' | 'error'

/** What a card is asked about: the caller's org, optionally one specific factory. */
export interface ConnectionCardContext {
  orgId: string
  userId: string
  /** When set, the card describes this factory only; otherwise it aggregates. */
  factoryProjectId?: string
}

/** A card's answer. Secret-free by contract: this is rendered in the Factory UI. */
export interface ConnectionCardResult {
  status: ConnectionCardStatus
  /** Overrides the default status label shown to the user. */
  label?: string
  /** One-line context (e.g. `https://hitly.example.com · proj_1`). No secrets. */
  detail?: string
}

export interface ConnectionCard {
  /** Stable unique id. Re-registering the same id replaces the card. */
  id: string
  name: string
  description: string
  /** Short glyph rendered in the card; never an external asset URL. */
  icon?: string
  /** Absolute path the "Open" action links to, served by the owning plugin. */
  settingsPath?: string
  /** Sort key; ties break on `name` then `id` so order is always stable. */
  order?: number
  /**
   * Report status for the current org/factory. Throw (or reject) to have the
   * card dropped from the screen rather than shown broken.
   */
  status(context: ConnectionCardContext): Promise<ConnectionCardResult>
}

/** A card plus its resolved status, as served to the bootstrap. */
export interface ConnectionCardView {
  id: string
  name: string
  description: string
  icon: string
  settingsPath: string | null
  status: ConnectionCardStatus
  label: string
  detail: string | null
}

export const DEFAULT_CARD_TIMEOUT_MS = 2000

export const DEFAULT_STATUS_LABELS: Record<ConnectionCardStatus, string> = {
  connected: 'Connected',
  'not-connected': 'Not connected',
  'env-fallback': 'Env fallback',
  error: 'Unavailable',
}

interface CardRegistryState {
  cards: Map<string, ConnectionCard>
}

/**
 * Shared key for the interim registry. Deliberately `Symbol.for` on
 * `globalThis`: the patch is applied to a third-party SPA, so registration
 * must survive module duplication and cannot rely on a module-local map.
 * Delete this whole module when upstream ships the extension point (#211).
 */
const CARD_REGISTRY_KEY = Symbol.for('@hitly/mastra-factory-plugin.connection-cards')

function globalScope(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>
}

function registryState(): CardRegistryState {
  const scope = globalScope()
  let state = scope[CARD_REGISTRY_KEY] as CardRegistryState | undefined
  if (!state || !(state.cards instanceof Map)) {
    state = { cards: new Map<string, ConnectionCard>() }
    scope[CARD_REGISTRY_KEY] = state
  }
  return state
}

/** Register (or replace) a connection card. Idempotent, safe to call at module load. */
export function registerConnectionCard(card: ConnectionCard): void {
  if (!card || !card.id) throw new TypeError('connection card requires an id')
  if (!card.name) throw new TypeError(`connection card "${card.id}" requires a name`)
  if (typeof card.status !== 'function') throw new TypeError(`connection card "${card.id}" requires status()`)
  registryState().cards.set(card.id, card)
}

/** Remove a card by id. Returns whether a card was present. */
export function unregisterConnectionCard(id: string): boolean {
  return registryState().cards.delete(id)
}

/** Registered cards in render order: `order`, then `name`, then `id`. */
export function listConnectionCards(): ConnectionCard[] {
  return [...registryState().cards.values()].sort(
    (a, b) =>
      (a.order ?? 100) - (b.order ?? 100) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  )
}

/** Drop every card. Intended for tests, which import the module fresh but share the global. */
export function clearConnectionCards(): void {
  registryState().cards.clear()
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    // Not unref'd on purpose: the cleared-on-settle timer is what keeps a
    // stalled card's rejection reachable instead of orphaning the promise.
    const timer = setTimeout(() => reject(new Error(`connection card timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve every registered card for one caller. A card that throws or stalls
 * is logged and omitted — it must never take the Connections screen down with
 * it, and must not stop the other cards from rendering.
 */
export async function collectConnectionCards(
  context: ConnectionCardContext,
  options: { timeoutMs?: number; log?(level: string, message: string, meta?: Record<string, unknown>): void } = {},
): Promise<ConnectionCardView[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CARD_TIMEOUT_MS
  // Resolved concurrently so one slow card cannot add its latency to the rest;
  // views and warn logs are then emitted in render order, so the screen (and the
  // log) never depends on which card happened to settle first.
  const settled = await Promise.all(
    listConnectionCards().map(async (card): Promise<{ card: ConnectionCard; view?: ConnectionCardView; error?: unknown }> => {
      try {
        const result = await withTimeout(Promise.resolve(card.status(context)), timeoutMs)
        return {
          card,
          view: {
            id: card.id,
            name: card.name,
            description: card.description,
            icon: card.icon ?? '',
            settingsPath: card.settingsPath ?? null,
            status: result.status,
            label: result.label ?? DEFAULT_STATUS_LABELS[result.status] ?? result.status,
            detail: result.detail ?? null,
          },
        }
      } catch (error) {
        return { card, error }
      }
    }),
  )
  const views: ConnectionCardView[] = []
  for (const entry of settled) {
    if (entry.view) views.push(entry.view)
    else
      options.log?.('warn', 'hitly: connection card skipped', {
        cardId: entry.card.id,
        error: errorDetail(entry.error),
      })
  }
  return views
}
