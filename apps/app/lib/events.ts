import { projectEvents } from '@hitly/db/schema'
import { newId } from './ids'
import { requireDb, requireTenantWorkspaceId } from './tenant'

export async function logProjectEvent(args: {
  workspaceId?: string
  projectId: string
  approvalId?: string | null
  level?: 'info' | 'warn' | 'error'
  type: string
  message: string
  payload?: Record<string, unknown>
}) {
  const workspaceId = args.workspaceId ?? requireTenantWorkspaceId()
  const database = requireDb()
  await database.insert(projectEvents).values({
    id: newId('evt').slice(0, 36),
    workspaceId,
    projectId: args.projectId,
    approvalId: args.approvalId ?? null,
    level: args.level ?? 'info',
    type: args.type,
    message: args.message,
    payload: args.payload ?? {},
  })
}
