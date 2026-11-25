import type { PluginRuntimeConfig } from './types.ts'
import type { HitlyClientLike } from './gates.ts'

export interface SessionTargetSeams {
  resolveSessionTarget(requestContext: unknown): {
    sessionId: string
    threadId?: string
    orgId?: string
    userId?: string
    factoryProjectId?: string
  } | null
}

export interface HitlyPluginOptions {
  config: PluginRuntimeConfig
  client: HitlyClientLike
  seams: SessionTargetSeams
  /** HITLy project-config gate overrides (authoritative when fetched). */
  gateOverrides?: Partial<Record<'plan' | 'review' | 'ask_user', boolean>>
  mergeAfterAcceptOverride?: boolean
}

/**
 * FactoryIntegration implementation. Constructed on the Factory host:
 *   new MastraFactory({ integrations: [new HitlyMastraFactoryPlugin({...})] })
 */
export class HitlyMastraFactoryPlugin {
  readonly id = 'hitly'
  constructor(_options: HitlyPluginOptions) {
    // Phase 3+ wires behavior; see docs/SPIKE.md for the proven seams.
  }
  routes(_ctx: unknown): Array<{ path: string; method: string }> {
    throw new Error('not implemented')
  }
  postToolObserver(_args: unknown): Promise<void> | void {
    throw new Error('not implemented')
  }
  diagnostics(): Record<string, unknown> {
    throw new Error('not implemented')
  }
}
