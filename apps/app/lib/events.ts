import { projectEvents } from '@hitly/db/schema'
import { newId } from './ids'
import { requireDb } from './require-db'

export async function logProjectEvent(args: {
  projectId: string
  approvalId?: string | null
  level?: 'info' | 'warn' | 'error'
  type: string
  message: string
  payload?: Record<string, unknown>
}) {
  const database = requireDb()
  await database.insert(projectEvents).values({
    id: newId('evt').slice(0, 36),
    projectId: args.projectId,
    approvalId: args.approvalId ?? null,
    level: args.level ?? 'info',
    type: args.type,
    message: args.message,
    payload: args.payload ?? {},
  })
}
