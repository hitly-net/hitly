import { and, asc, eq, ne } from 'drizzle-orm'
import { isWorkspaceAdmin } from '@hitly/core'
import { projectMemberships, projects } from '@hitly/db/schema'
import type { AuthorizeContext } from '@hitly/cloud/mcp-oauth/routes'
import { listUserWorkspaces } from './workspace'
import { requireDb, withTenant } from './tenant'

/**
 * Projects an operator may grant to a marketplace agent. Consent is an
 * admin act, so a project qualifies when the user administers its workspace
 * or holds the project-admin role; archived projects never qualify. Queries
 * run under the workspace tenant context (RLS pins project tables).
 */
export async function buildAuthorizeContext(userId: string): Promise<AuthorizeContext> {
  const workspaces = await listUserWorkspaces(userId)
  const grants: AuthorizeContext['projects'] = []
  for (const ws of workspaces) {
    const rows = await withTenant(ws.id, async () => {
      const database = requireDb()
      if (isWorkspaceAdmin(ws.role)) {
        return database
          .select({ projectId: projects.id, projectName: projects.name })
          .from(projects)
          .where(and(eq(projects.workspaceId, ws.id), ne(projects.status, 'archived')))
          .orderBy(asc(projects.name))
      }
      return database
        .select({ projectId: projects.id, projectName: projects.name })
        .from(projects)
        .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
        .where(
          and(
            eq(projects.workspaceId, ws.id),
            ne(projects.status, 'archived'),
            eq(projectMemberships.userId, userId),
            eq(projectMemberships.role, 'admin'),
          ),
        )
        .orderBy(asc(projects.name))
    })
    for (const row of rows) {
      grants.push({ workspaceId: ws.id, workspaceName: ws.name, projectId: row.projectId, projectName: row.projectName })
    }
  }
  return { userId, projects: grants }
}
