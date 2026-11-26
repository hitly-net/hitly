import { authenticateProjectKey } from '@/lib/approvals'
import { applyFailedAuthLimit, applyRestLimit, apiKeyRestSubject } from '@/lib/rest-limit'
import { withTenant } from '@/lib/tenant'
import {
  handleMastraFactoryApprovalsList,
  listOpenMastraFactoryApprovals,
} from '@/lib/mastra-factory-approvals'

/**
 * GET /api/v1/projects/:id/integrations/mastra-factory/approvals —
 * restart-seed feed for the mastra-factory plugin (project API key): open
 * gate approvals with the gate + Factory session identity captured at create
 * time. Exposes only the plugin's own `net.hitly/*` metadata, never secrets.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return handleMastraFactoryApprovalsList(request, id, {
    authenticate: authenticateProjectKey,
    applyRestReadLimit: async (subject) => await applyRestLimit('read', apiKeyRestSubject(subject)),
    applyRestWriteLimit: async (subject) => await applyRestLimit('write', apiKeyRestSubject(subject)),
    applyFailedAuth: (request) => applyFailedAuthLimit(request),
    listOpen: async (projectId, workspaceId) =>
      withTenant(workspaceId, () => listOpenMastraFactoryApprovals({ workspaceId, projectId })),
    readState: async () => null,
    ack: async () => ({ error: 'Not found', status: 404 as const }),
  })
}
