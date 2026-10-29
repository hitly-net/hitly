import { and, eq } from 'drizzle-orm'
import { projectEvents } from '@hitly/db/schema'

import { logProjectEvent } from './events'
import { requireDb } from './tenant'

/**
 * Context open tracking (hitl-spec 3.7/4.3/5.2).
 *
 * There is no separate open-events model: every open is recorded as a `projectEvents`
 * audit row (type `opened`) carrying `openedAt` plus the actor, and the audit query
 * below reads them back for gating. Keeps one audit shape (the project event log the
 * app already renders on the logs page) instead of inventing a parallel model.
 */

export interface ContextOpenEvent {
  /** Gating key of the opened item (ref, or derived from url/name). */
  itemRef: string
  /** ISO timestamp of the open (spec `activity.items[].openedAt` entry). */
  openedAt: string
  /** Always `client` for now: opens are reported by the reviewer client on click. */
  source: 'client'
  /** Reviewer who opened the item, when known. */
  userId?: string
  url?: string
}

/**
 * Gating keys (refs) the reviewer has opened on this approval. When `actorUserId` is
 * given, only that reviewer's opens count (spec 3.7: the reviewer must have opened
 * the item before answering). An empty `actorUserId` (e.g. retry-resume) accepts
 * opens recorded by anyone, because the original decision already passed its gate.
 */
export async function loadOpenedContextRefs(args: {
  approvalId: string
  workspaceId: string
  actorUserId?: string
}): Promise<string[]> {
  const database = requireDb()
  const rows = await database
    .select({ payload: projectEvents.payload })
    .from(projectEvents)
    .where(
      and(
        eq(projectEvents.approvalId, args.approvalId),
        eq(projectEvents.workspaceId, args.workspaceId),
        eq(projectEvents.type, 'opened'),
      ),
    )

  const refs = new Set<string>()
  for (const row of rows) {
    const event = row.payload as Partial<ContextOpenEvent> | null
    if (!event || typeof event.itemRef !== 'string' || !event.itemRef) continue
    if (args.actorUserId && event.userId !== args.actorUserId) continue
    refs.add(event.itemRef)
  }
  return [...refs]
}

/** Record one context open as an `opened` project audit event with its `openedAt`. */
export async function recordContextOpen(args: {
  workspaceId: string
  projectId: string
  approvalId: string
  ref: string
  url?: string
  userId?: string
}): Promise<ContextOpenEvent> {
  const event: ContextOpenEvent = {
    itemRef: args.ref,
    openedAt: new Date().toISOString(),
    source: 'client',
  }
  if (args.userId) event.userId = args.userId
  if (args.url) event.url = args.url

  await logProjectEvent({
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    approvalId: args.approvalId,
    type: 'opened',
    message: `Opened context item: ${args.ref}`,
    payload: { ...event },
  })
  return event
}
