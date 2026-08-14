import { eq } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { generateResumeSecret } from './keys'
import { requireDb } from './require-db'

export async function ensureProjectResumeSecret(project: typeof projects.$inferSelect) {
  const existing = typeof project.credentials.resumeSecret === 'string' ? project.credentials.resumeSecret.trim() : ''
  if (existing) return { project, resumeSecret: existing }
  const resumeSecret = generateResumeSecret()
  const credentials: Record<string, unknown> = { ...project.credentials, resumeSecret }
  await requireDb().update(projects).set({ credentials }).where(eq(projects.id, project.id))
  return { project: { ...project, credentials }, resumeSecret }
}

export async function rotateProjectResumeSecret(projectId: string) {
  const database = requireDb()
  const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  const project = rows[0]
  if (!project) return { error: 'Project not found' as const }
  const resumeSecret = generateResumeSecret()
  const credentials: Record<string, unknown> = { ...project.credentials, resumeSecret }
  await database.update(projects).set({ credentials }).where(eq(projects.id, projectId))
  return { ok: true as const, resumeSecret }
}
