import { authenticateProjectKey } from '@/lib/approvals'
import { applyFailedAuthLimit, applyRestLimit, apiKeyRestSubject } from '@/lib/rest-limit'
import { withTenant } from '@/lib/tenant'
import { getMastraFactoryApprovalState, handleMastraFactoryApprovalGet } from '@/lib/mastra-factory-approvals'

/**
 * GET /api/v1/projects/:id/integrations/mastra-factory/approvals/:approvalId —
 * authority read for the mastra-factory plugin (project API key): the plugin
 * trusts only this status/decision, never the decided callback's claim.
 * Read-time expiry is settled here, so an expired row never reads `pending`.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string; approvalId: string }> }) {
  const { id, approvalId } = await context.params
  return handleMastraFactoryApprovalGet(request, id, approvalId, {
    authenticate: authenticateProjectKey,
    applyRestReadLimit: async (subject) => await applyRestLimit('read', apiKeyRestSubject(subject)),
    applyFailedAuth: (request) => applyFailedAuthLimit(request),
    listOpen: async () => ({ approvals: [] }),
    readState: async (projectId, workspaceId, approvalId) =>
      withTenant(workspaceId, () => getMastraFactoryApprovalState({ workspaceId, projectId, approvalId })),
  })
}
