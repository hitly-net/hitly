import { eq } from 'drizzle-orm'
import { workspaces } from '@hitly/db/schema'
import { requireDb } from './require-db'

export function parseWorkspaceSettings(input: { name?: unknown; timezone?: unknown; sla?: unknown }) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const timezone = (typeof input.timezone === 'string' ? input.timezone.trim() : '') || 'UTC'
  const sla = (typeof input.sla === 'string' ? input.sla.trim() : '') || '60'
  if (!name) return { error: 'Name is required' as const }
  return { name, timezone, sla }
}

export async function saveWorkspaceSettings(
  workspaceId: string,
  input: { name: string; timezone: string; sla: string },
) {
  const database = requireDb()
  await database
    .update(workspaces)
    .set({ name: input.name, timezone: input.timezone, defaultSlaMinutes: input.sla })
    .where(eq(workspaces.id, workspaceId))
}
