import { edition } from '@hitly/cloud'
import type { TenantDocument } from '@hitly/core'

export async function encodeTenantJson(workspaceId: string, value: TenantDocument): Promise<TenantDocument> {
  if (edition.encryptDocument) return edition.encryptDocument(workspaceId, value)
  return value
}

export async function decodeTenantJson(workspaceId: string, value: TenantDocument | null | undefined): Promise<TenantDocument> {
  if (!value) return {}
  if (edition.decryptDocument) return edition.decryptDocument(workspaceId, value)
  return value
}
