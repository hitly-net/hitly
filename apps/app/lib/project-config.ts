import { and, eq } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { generateResumeSecret } from './keys'
import { requireDb, requireTenantWorkspaceId } from './tenant'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'

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
  evidenceSinkType: 'none' | 'http'
  evidenceSinkUrl: string
  evidenceSinkAuthHeader: string
  evidenceSinkHeaders: string
  evidenceSinkMetadata: string
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
  const evidenceSinkType = typeof input.evidenceSinkType === 'string' ? input.evidenceSinkType.trim() : 'none'
  const evidenceSinkUrl = typeof input.evidenceSinkUrl === 'string' ? input.evidenceSinkUrl.trim() : ''
  const evidenceSinkAuthHeader = typeof input.evidenceSinkAuthHeader === 'string' ? input.evidenceSinkAuthHeader.trim() : ''
  const evidenceSinkHeaders = typeof input.evidenceSinkHeaders === 'string' ? input.evidenceSinkHeaders.trim() : ''
  const evidenceSinkMetadata = typeof input.evidenceSinkMetadata === 'string' ? input.evidenceSinkMetadata.trim() : ''

  if (evidenceSinkMetadata) {
    try {
      const parsed = JSON.parse(evidenceSinkMetadata)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { error: 'Metadata must be a JSON object' }
      }
    } catch {
      return { error: 'Metadata must be valid JSON' }
    }
  }

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
    evidenceSinkType: evidenceSinkType === 'http' ? 'http' : 'none',
    evidenceSinkUrl,
    evidenceSinkAuthHeader,
    evidenceSinkHeaders,
    evidenceSinkMetadata,
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
  const workspaceId = requireTenantWorkspaceId()
  const database = requireDb()
  const rows = await database
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  const project = rows[0]
  if (!project) return { error: 'Project not found' as const }
  const current = await decodeTenantJson(workspaceId, project.credentials)

  const credentials: Record<string, unknown> = { plugin: project.plugin, ...current }
  if (input.baseUrl) credentials.baseUrl = input.baseUrl
  if (input.token) credentials.token = input.token
  if (input.address) credentials.address = input.address
  if (input.namespace) credentials.namespace = input.namespace
  if (input.taskQueue) credentials.taskQueue = input.taskQueue
  if (project.plugin === 'langgraph' && input.baseUrl) credentials.deploymentUrl = input.baseUrl
  if (typeof credentials.resumeSecret !== 'string' || !credentials.resumeSecret) {
    credentials.resumeSecret = generateResumeSecret()
  }

  let sinkConfig: Record<string, unknown> = {}
  if (project.evidenceSinkConfig) {
    const existing = await decodeTenantJson(workspaceId, project.evidenceSinkConfig)
    sinkConfig = existing as Record<string, unknown>
  }

  if (input.evidenceSinkUrl) sinkConfig.url = input.evidenceSinkUrl
  if (input.evidenceSinkAuthHeader) sinkConfig.authHeader = input.evidenceSinkAuthHeader
  if (input.evidenceSinkHeaders) {
    const headers: Record<string, string> = {}
    for (const line of input.evidenceSinkHeaders.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) {
        const colonIndex = trimmed.indexOf(':')
        if (colonIndex > 0) {
          const name = trimmed.slice(0, colonIndex).trim()
          const value = trimmed.slice(colonIndex + 1).trim()
          if (name) headers[name] = value
        }
      }
    }
    sinkConfig.headers = headers
  }
  if (input.evidenceSinkMetadata) {
    sinkConfig.metadata = JSON.parse(input.evidenceSinkMetadata)
  }

  await database
    .update(projects)
    .set({
      name: input.name,
      description: input.description || null,
      defaultSlaMinutes: input.sla,
      defaultAssigneeUserId: input.defaultAssigneeUserId,
      credentials: await encodeTenantJson(workspaceId, credentials),
      evidenceSinkType: input.evidenceSinkType,
      evidenceSinkConfig: Object.keys(sinkConfig).length > 0 ? await encodeTenantJson(workspaceId, sinkConfig) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))

  return { ok: true as const }
}
