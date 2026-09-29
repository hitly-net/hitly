import { NextResponse } from 'next/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import { approvals, decisionRecords } from '@hitly/db/schema'
import { requireDb, withTenant } from '@/lib/tenant'
import { decodeTenantJson } from '@/lib/tenant-crypto'
import { authenticateProjectKey } from '@/lib/approvals'
import { isDecision, type Decision } from '@hitly/core'

/**
 * GET /api/v1/approvals/by-run-id?runId=<runId>&plugin=<plugin>
 *
 * Query approvals by origin.runId (e.g., "sandbox-123:chunk-456" for OpenShell).
 * Returns the latest approval (by updatedAt) matching the runId and plugin.
 *
 * Auth: Project API key (same as POST /api/v1/approvals ingest flow).
 *
 * Use case: OpenShell gateway interceptor queries HITLy to verify human decision
 * exists before allowing ApproveDraftChunk or RejectDraftChunk.
 */
export async function GET(request: Request) {
  try {
    const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
    }

    const url = new URL(request.url)
    const runId = url.searchParams.get('runId')
    const plugin = url.searchParams.get('plugin')

    if (!runId) {
      return NextResponse.json({ error: 'Missing required query parameter: runId' }, { status: 400 })
    }

    const authn = await authenticateProjectKey(apiKey)
    if (!authn) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
    }

    const { project } = authn

    return await withTenant(project.workspaceId, async () => {
      const database = requireDb()

      // Query approvals where origin->>'runId' = $runId
      // Order by updatedAt DESC to get the latest approval
      const filters = [
        eq(approvals.workspaceId, project.workspaceId),
        eq(approvals.projectId, project.id),
        sql`${approvals.origin}->>'runId' = ${runId}`,
      ]

      if (plugin) {
        // Cast plugin string to enum type for type safety
        filters.push(sql`${approvals.plugin} = ${plugin}`)
      }

      const rows = await database
        .select({
          id: approvals.id,
          status: approvals.status,
          plugin: approvals.plugin,
          actionName: approvals.actionName,
          origin: approvals.origin,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(approvals)
        .where(and(...filters))
        .orderBy(desc(approvals.updatedAt))
        .limit(1)

      if (rows.length === 0) {
        return NextResponse.json(
          { error: `No approval found for runId ${runId}${plugin ? ` and plugin ${plugin}` : ''}` },
          { status: 404 },
        )
      }

      const approval = rows[0]!
      const decodedOrigin = await decodeTenantJson(project.workspaceId, approval.origin)
      
      // Fetch the latest decision for this approval (if any)
      const decisionRows = await database
        .select({
          decision: decisionRecords.decision,
        })
        .from(decisionRecords)
        .where(
          and(
            eq(decisionRecords.approvalId, approval.id),
            eq(decisionRecords.workspaceId, project.workspaceId),
          ),
        )
        .orderBy(desc(decisionRecords.createdAt))
        .limit(1)

      const latestDecision = decisionRows[0]
      const decision: Decision | null = latestDecision && isDecision(latestDecision.decision) 
        ? (latestDecision.decision as Decision)
        : null
      
      return NextResponse.json({
        id: approval.id,
        status: approval.status,
        decision,
        plugin: approval.plugin,
        actionName: approval.actionName,
        runId: typeof decodedOrigin === 'object' && decodedOrigin && 'runId' in decodedOrigin 
          ? decodedOrigin.runId 
          : null,
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Query failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
