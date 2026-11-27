/**
 * The HITLy card shown on the Factory Settings → Connections screen
 * (hitly-net/hitly#218). It is the first card registered through the interim
 * registry in connection-cards.ts and is removed together with that patch
 * once upstream ships the extension point (#211).
 *
 * @mastra-free, like the rest of this package outside factory-seams.ts.
 */

import type { HitlyConnectionRegistry } from './connections.ts'
import { registerConnectionCard, type ConnectionCard, type ConnectionCardContext, type ConnectionCardResult } from './connection-cards.ts'
import { SETTINGS_BASE_PATH } from './settings-routes.ts'

export const HITLY_CARD_ID = 'hitly'

/** Late-bound because host storage (and therefore the registry) arrives after construction. */
export interface HitlyCardDeps {
  getRegistry(): HitlyConnectionRegistry | null
  settingsPath?: string
}

function describeConnection(conn: { status: { hitlyBaseUrl: string; projectId: string; lastError?: string | null } }): string {
  const base = `${conn.status.hitlyBaseUrl} · project ${conn.status.projectId}`
  return conn.status.lastError ? `${base} · last error: ${conn.status.lastError}` : base
}

async function statusFor(context: ConnectionCardContext, deps: HitlyCardDeps): Promise<ConnectionCardResult> {
  const registry = deps.getRegistry()
  // No registry means no host integration storage: the settings surface cannot
  // work either, so drop the card instead of offering a dead link.
  if (!registry) throw new Error('connection registry unavailable')

  if (context.factoryProjectId) {
    const conn = await registry.resolve(context.orgId, context.factoryProjectId)
    if (!conn) return { status: 'not-connected' }
    if (conn.source === 'env') return { status: 'env-fallback', detail: describeConnection(conn) }
    return { status: 'connected', detail: describeConnection(conn) }
  }

  const conns = (await registry.listAll()).filter((conn) => conn.orgId === context.orgId)
  const saved = conns.filter((conn) => conn.source === 'saved')
  if (saved.length > 0) {
    return { status: 'connected', detail: `${saved.length} factor${saved.length === 1 ? 'y' : 'ies'} connected` }
  }
  if (conns.length > 0) {
    return { status: 'env-fallback', detail: `${conns.length} factor${conns.length === 1 ? 'y' : 'ies'} on env fallback` }
  }
  return { status: 'not-connected' }
}

/** Build the HITLy connection card. */
export function createHitlyConnectionCard(deps: HitlyCardDeps): ConnectionCard {
  return {
    id: HITLY_CARD_ID,
    name: 'HITLy',
    description: 'Human-in-the-loop gates for planning, review, and questions.',
    icon: '🤝',
    settingsPath: deps.settingsPath ?? SETTINGS_BASE_PATH,
    order: 10,
    status: (context) => statusFor(context, deps),
  }
}

/** Register the HITLy card with the shared Connections registry. */
export function registerHitlyConnectionCard(deps: HitlyCardDeps): ConnectionCard {
  const card = createHitlyConnectionCard(deps)
  registerConnectionCard(card)
  return card
}
