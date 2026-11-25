/**
 * HITLy-server-side plugin for `plugin: "mastra-factory"` projects.
 *
 * MUST NOT import anything from `@mastra/*` — this module is loaded by the
 * HITLy app server (apps/app/lib/plugins.ts), which never installs the
 * Factory host packages. Enforced by a static-scan test in index.test.ts.
 */
import { httpPlugin } from '@hitly/plugin-http'
import type { HitlyPlugin, ResumeResponse } from '@hitly/core'

export const mastraFactoryPlugin: HitlyPlugin = {
  id: 'mastra-factory' as HitlyPlugin['id'],
  ingest(raw: unknown): ReturnType<HitlyPlugin['ingest']> {
    // Phase 7: validate gate metadata + default action names, then delegate to
    // the http plugin ingest (same create-once/resume-handle storage shape).
    return httpPlugin.ingest(raw)
  },
  resume(origin, payload, credentials): Promise<ResumeResponse | void> {
    return httpPlugin.resume(origin, payload, credentials)
  },
  healthcheck(credentials): Promise<'ok' | 'error'> {
    return httpPlugin.healthcheck(credentials)
  },
}
