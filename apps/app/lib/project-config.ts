import { eq } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { generateResumeSecret } from './keys'
import { requireDb } from './require-db'

export type ProjectConfigInput = {
  name: string
  description: string
  sla: string
  baseUrl: string
  token: string
  namespace: string
  taskQueue: string
  address: string
  defaultAssigneeUserId: string | null
}

export function parseProjectConfig(input: Record<string, unknown>): ProjectConfigInput | { error: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { error: 'Name is required' }
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const sla = (typeof input.sla === 'string' ? input.sla.trim() : '') || '60'
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const namespace = typeof input.namespace === 'string' ? input.namespace.trim() : ''
  const taskQueue = typeof input.taskQueue === 'string' ? input.taskQueue.trim() : ''
  const address = typeof input.address === 'string' ? input.address.trim() : ''
  const assignee = typeof input.defaultAssigneeUserId === 'string' ? input.defaultAssigneeUserId.trim() : ''
  return {
    name,
    description,
    sla,
    baseUrl,
    token,
    namespace,
    taskQueue,
    address,
    defaultAssigneeUserId: assignee || null,
  }
}

export function publicOriginFields(plugin: string, credentials: Record<string, unknown>) {
  return {
    baseUrl: String(credentials.baseUrl ?? credentials.deploymentUrl ?? ''),
    address: plugin === 'temporal' ? String(credentials.address ?? '') : '',
    namespace: plugin === 'temporal' ? String(credentials.namespace ?? 'default') : '',
    taskQueue: plugin === 'temporal' ? String(credentials.taskQueue ?? '') : '',
  }
}

export async function saveProjectConfig(projectId: string, input: ProjectConfigInput) {
  const database = requireDb()
  const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  const project = rows[0]
  if (!project) return { error: 'Project not found' as const }

  const credentials: Record<string, unknown> = { plugin: project.plugin, ...project.credentials }
  if (input.baseUrl) credentials.baseUrl = input.baseUrl
  if (input.token) credentials.token = input.token
  if (input.address) credentials.address = input.address
  if (input.namespace) credentials.namespace = input.namespace
  if (input.taskQueue) credentials.taskQueue = input.taskQueue
  if (project.plugin === 'langgraph' && input.baseUrl) credentials.deploymentUrl = input.baseUrl
  if (typeof credentials.resumeSecret !== 'string' || !credentials.resumeSecret) {
    credentials.resumeSecret = generateResumeSecret()
  }

  await database
    .update(projects)
    .set({
      name: input.name,
      description: input.description || null,
      defaultSlaMinutes: input.sla,
      defaultAssigneeUserId: input.defaultAssigneeUserId,
      credentials,
    })
    .where(eq(projects.id, projectId))

  return { ok: true as const }
}
