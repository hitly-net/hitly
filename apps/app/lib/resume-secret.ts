import { and, eq } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { generateResumeSecret } from './keys'
import { requireDb, requireTenantWorkspaceId } from './tenant'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'

export async function ensureProjectResumeSecret(project: typeof projects.$inferSelect) {
  const workspaceId = project.workspaceId
  const credentials = await decodeTenantJson(workspaceId, project.credentials)
  const existing = typeof credentials.resumeSecret === 'string' ? credentials.resumeSecret.trim() : ''
  if (existing) return { project: { ...project, credentials }, resumeSecret: existing }
  const resumeSecret = generateResumeSecret()
  const next = { ...credentials, resumeSecret }
  await requireDb()
    .update(projects)
    .set({ credentials: await encodeTenantJson(workspaceId, next), updatedAt: new Date() })
    .where(and(eq(projects.id, project.id), eq(projects.workspaceId, workspaceId)))
  return { project: { ...project, credentials: next }, resumeSecret }
}

export async function rotateProjectResumeSecret(projectId: string) {
  const workspaceId = requireTenantWorkspaceId()
  const database = requireDb()
  const rows = await database
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  const project = rows[0]
  if (!project) return { error: 'Project not found' as const }
  const credentials = await decodeTenantJson(workspaceId, project.credentials)
  const resumeSecret = generateResumeSecret()
  const next = { ...credentials, resumeSecret }
  await database
    .update(projects)
    .set({ credentials: await encodeTenantJson(workspaceId, next), updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
  return { ok: true as const, resumeSecret }
}
