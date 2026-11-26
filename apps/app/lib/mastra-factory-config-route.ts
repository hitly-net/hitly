import { NextResponse } from 'next/server'
import { isWellFormedApiKey } from './keys'
import { parseMastraFactoryConfig } from './mastra-factory-config'

/**
 * Dependencies for {@link handleMastraFactoryConfigGet}, injectable so the
 * auth/limit/decode pipeline is testable without a database (same pattern as
 * `ingest-route.ts`).
 */
export interface MastraFactoryConfigGetDeps {
  authenticate: (
    apiKey: string,
    projectId: string,
  ) => Promise<{ project: { plugin: string; workspaceId: string; credentials: Record<string, unknown> } } | null>
  applyRestReadLimit: (subject: string) => Promise<NextResponse | null>
  applyFailedAuth: (request: Request) => Promise<NextResponse | null>
  decodeCredentials: (workspaceId: string, credentials: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/**
 * GET /api/v1/projects/:id/integrations/mastra-factory — authoritative gate
 * state for the `@hitly/mastra-factory-plugin` (project API key). The Factory
 * host polls this after verifying a HITLy callback, and the reconciler refresh
 * fails closed to this state, so the response must reflect exactly what the
 * Config panel saved (defaults when unset): gates all on, merge-after-accept
 * off. Never exposes secrets.
 */
export async function handleMastraFactoryConfigGet(request: Request, projectId: string, deps: MastraFactoryConfigGetDeps) {
  const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!apiKey) return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
  if (isWellFormedApiKey(apiKey)) {
    const authn = await deps.authenticate(apiKey, projectId)
    if (!authn) {
      const failed = await deps.applyFailedAuth(request)
      if (failed) return failed
      return NextResponse.json({ error: 'Invalid API key or project' }, { status: 401 })
    }
    const limited = await deps.applyRestReadLimit(apiKey)
    if (limited) return limited
    if (authn.project.plugin !== 'mastra-factory') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const credentials = await deps.decodeCredentials(authn.project.workspaceId, authn.project.credentials)
    return NextResponse.json(parseMastraFactoryConfig(credentials))
  }
  const failed = await deps.applyFailedAuth(request)
  if (failed) return failed
  return NextResponse.json({ error: 'Invalid API key or project' }, { status: 401 })
}
