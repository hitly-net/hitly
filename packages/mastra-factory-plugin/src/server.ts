/**
 * HITLy-server-side plugin for `plugin: "mastra-factory"` projects.
 *
 * MUST NOT import anything from `@mastra/*` — this module is loaded by the
 * HITLy app server (apps/app/lib/plugins.ts), which never installs the
 * Factory host packages. Enforced by a static-scan test in index.test.ts.
 */
import { httpPlugin } from '@hitly/plugin-http'
import type { HitlyPlugin, ResumeResponse } from '@hitly/core'

export type { Gate } from './types.ts'

export const mastraFactoryPlugin: HitlyPlugin = {
  id: 'mastra-factory',
  ingest(raw: unknown): ReturnType<HitlyPlugin['ingest']> {
    // Same create-once/resume-handle storage shape as the HTTP plugin; the
    // origin stamp must say `mastra-factory` so the approval row, the inbox
    // brand, and resume dispatch stay on this plugin id.
    const envelope = httpPlugin.ingest(raw)
    return { ...envelope, origin: { ...envelope.origin, plugin: 'mastra-factory' } }
  },
  resume(origin, payload, credentials): Promise<ResumeResponse | void> {
    return httpPlugin.resume(origin, payload, credentials)
  },
  healthcheck(credentials): Promise<'ok' | 'error'> {
    return httpPlugin.healthcheck(credentials)
  },
}
