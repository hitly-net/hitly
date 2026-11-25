import { authenticateProjectKey } from '@/lib/approvals'
import { applyFailedAuthLimit, applyRestLimit, apiKeyRestSubject } from '@/lib/rest-limit'
import { decodeTenantJson } from '@/lib/tenant-crypto'
import { handleMastraFactoryConfigGet } from '@/lib/mastra-factory-config-route'

/**
 * GET /api/v1/projects/:id/integrations/mastra-factory — authoritative gate
 * state for the `@hitly/mastra-factory-plugin` (project API key). The Factory
 * host polls this after verifying a HITLy callback, and the reconciler refresh
 * fails closed to this state, so the response must reflect exactly what the
 * Config panel saved (defaults when unset): gates all on, merge-after-accept
 * off. Never exposes secrets.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return handleMastraFactoryConfigGet(request, id, {
    authenticate: authenticateProjectKey,
    applyRestReadLimit: async (subject) => await applyRestLimit('read', apiKeyRestSubject(subject)),
    applyFailedAuth: (request) => applyFailedAuthLimit(request),
    decodeCredentials: (workspaceId, credentials) => decodeTenantJson(workspaceId, credentials),
  })
}
