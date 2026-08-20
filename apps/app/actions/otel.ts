'use server'

import { revalidatePath } from 'next/cache'
import { workspaceOtelEndpoints } from '@hitly/db/schema'
import { and, eq } from 'drizzle-orm'
import { getAppContext } from '@/lib/context'
import { canManageWorkspace } from '@/lib/rbac'
import { requireDb, requireTenantWorkspaceId } from '@/lib/tenant'
import { encodeTenantJson } from '@/lib/tenant-crypto'
import { newId } from '@/lib/ids'

export async function listOtelEndpoints() {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    return []
  }

  const database = requireDb()
  const endpoints = await database
    .select()
    .from(workspaceOtelEndpoints)
    .where(eq(workspaceOtelEndpoints.workspaceId, workspace.id))
    .orderBy(workspaceOtelEndpoints.createdAt)

  return endpoints
}

export async function addOtelEndpoint(formData: FormData) {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can manage OTEL endpoints')
  }

  const name = formData.get('name')?.toString().trim()
  const endpoint = formData.get('endpoint')?.toString().trim()
  const protocol = formData.get('protocol')?.toString().trim() as 'http/protobuf' | 'http/json'
  const headersText = formData.get('headers')?.toString().trim()

  if (!name) throw new Error('Name is required')
  if (!endpoint) throw new Error('Endpoint is required')
  if (!protocol || (protocol !== 'http/protobuf' && protocol !== 'http/json')) {
    throw new Error('Protocol must be http/protobuf or http/json')
  }

  const headers: Record<string, string> = {}
  if (headersText) {
    for (const line of headersText.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) {
        const colonIndex = trimmed.indexOf(':')
        if (colonIndex > 0) {
          const key = trimmed.slice(0, colonIndex).trim()
          const value = trimmed.slice(colonIndex + 1).trim()
          if (key) headers[key] = value
        }
      }
    }
  }

  const database = requireDb()
  const workspaceId = requireTenantWorkspaceId()

  await database.insert(workspaceOtelEndpoints).values({
    id: newId('ote').slice(0, 36),
    workspaceId,
    name,
    endpoint,
    protocol,
    headers: Object.keys(headers).length > 0 ? await encodeTenantJson(workspaceId, headers) : null,
    enabled: true,
  })

  revalidatePath('/settings/workspace')
}

export async function deleteOtelEndpoint(endpointId: string) {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can manage OTEL endpoints')
  }

  const database = requireDb()
  await database
    .delete(workspaceOtelEndpoints)
    .where(and(eq(workspaceOtelEndpoints.id, endpointId), eq(workspaceOtelEndpoints.workspaceId, workspace.id)))

  revalidatePath('/settings/workspace')
}

export async function toggleOtelEndpoint(endpointId: string) {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can manage OTEL endpoints')
  }

  const database = requireDb()
  const rows = await database
    .select()
    .from(workspaceOtelEndpoints)
    .where(and(eq(workspaceOtelEndpoints.id, endpointId), eq(workspaceOtelEndpoints.workspaceId, workspace.id)))
    .limit(1)

  const endpoint = rows[0]
  if (!endpoint) throw new Error('Endpoint not found')

  await database
    .update(workspaceOtelEndpoints)
    .set({ enabled: !endpoint.enabled, updatedAt: new Date() })
    .where(and(eq(workspaceOtelEndpoints.id, endpointId), eq(workspaceOtelEndpoints.workspaceId, workspace.id)))

  revalidatePath('/settings/workspace')
}
