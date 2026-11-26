import { authenticateProjectKey } from '@/lib/approvals'
import { applyFailedAuthLimit, applyRestLimit, apiKeyRestSubject } from '@/lib/rest-limit'
import { withTenant } from '@/lib/tenant'
import { ackMastraFactoryResume, handleMastraFactoryResumeAck } from '@/lib/mastra-factory-approvals'

/**
 * POST /api/v1/projects/:id/integrations/mastra-factory/approvals/:approvalId/resume-ack —
 * the mastra-factory plugin confirms it converged a `failed_resume` decision,
 * settling the row to `decided` so it stops replaying on every restart.
 * Idempotent: re-acking a `decided` row succeeds without further writes.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string; approvalId: string }> }) {
  const { id, approvalId } = await context.params
  return handleMastraFactoryResumeAck(request, id, approvalId, {
    authenticate: authenticateProjectKey,
    applyRestReadLimit: async (subject) => await applyRestLimit('read', apiKeyRestSubject(subject)),
    applyRestWriteLimit: async (subject) => await applyRestLimit('write', apiKeyRestSubject(subject)),
    applyFailedAuth: (request) => applyFailedAuthLimit(request),
    listOpen: async () => ({ approvals: [] }),
    readState: async () => null,
    ack: async (projectId, workspaceId, approvalId) =>
      withTenant(workspaceId, () => ackMastraFactoryResume({ workspaceId, projectId, approvalId })),
  })
}
