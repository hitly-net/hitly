import { and, eq } from 'drizzle-orm'
import type { OriginRef } from '@hitly/core'
import { projects } from '@hitly/db/schema'
import { deliverHttpLifecycleEvent, type LifecycleEventType } from '@hitly/plugin-http'
import { logProjectEvent } from './events'
import { requireDb } from './tenant'
import { decodeTenantJson } from './tenant-crypto'

/**
 * Host-side wiring for opt-in HTTP lifecycle events (M0h, hitly#106 item 6).
 *
 * The plugin decides WHETHER to deliver: `deliverHttpLifecycleEvent` no-ops
 * unless the request opted in via `lifecycleEvents` at ingest, so the default
 * stays a single final-decision POST (n8n Wait untouched). This helper only
 * decides WHEN, from the real lifecycle transitions: presented, opened,
 * cancelled, expired.
 *
 * Delivery is best-effort by design: a lifecycle callback must never fail the
 * reviewer's action (mark presented / record open / cancel / expire). Errors
 * are logged as `lifecycle` project events, never thrown. The event id is
 * derived deterministically per (approval, event), like the decided callback,
 * so receivers dedupe on X-HITLy-Event-Id.
 */
export async function deliverApprovalLifecycleEvent(args: {
  approval: {
    id: string
    projectId: string
    plugin: string
    origin: Record<string, unknown>
  }
  workspaceId: string
  type: LifecycleEventType
  state?: string
  /** Extra delivery context merged over the handle metadata (e.g. {ref, url} for `opened`). */
  extraMetadata?: Record<string, unknown>
}): Promise<void> {
  if (args.approval.plugin !== 'http') return
  try {
    const origin = (await decodeTenantJson(args.workspaceId, args.approval.origin)) as unknown as OriginRef
    if (!origin || typeof origin !== 'object' || !origin.resumeHandle) return
    const database = requireDb()
    const projectRows = await database
      .select()
      .from(projects)
      .where(and(eq(projects.id, args.approval.projectId), eq(projects.workspaceId, args.workspaceId)))
      .limit(1)
    const project = projectRows[0]
    const decodedCredentials = project
      ? ((await decodeTenantJson(args.workspaceId, project.credentials)) as Record<string, unknown>)
      : undefined
    const credentials = decodedCredentials ? { ...decodedCredentials, plugin: 'http' as const } : undefined
    const response = await deliverHttpLifecycleEvent({
      origin,
      type: args.type,
      credentials,
      approvalId: args.approval.id,
      state: args.state,
      extraMetadata: args.extraMetadata,
    })
    if (!response) return // not opted in (or no resumeUrl): no POST, no audit noise
    await logProjectEvent({
      workspaceId: args.workspaceId,
      projectId: args.approval.projectId,
      approvalId: args.approval.id,
      level: response.error || response.status < 200 || response.status >= 300 ? 'warn' : 'info',
      type: 'lifecycle',
      message: `HTTP lifecycle '${args.type}' delivery ${response.error ? `failed: ${response.error}` : `returned ${response.status}`}`,
      payload: { eventType: args.type, status: response.status },
    })
  } catch (error) {
    // Fail-open: the lifecycle callback is supplementary telemetry; the
    // reviewer action already succeeded and stays successful.
    try {
      await logProjectEvent({
        workspaceId: args.workspaceId,
        projectId: args.approval.projectId,
        approvalId: args.approval.id,
        level: 'warn',
        type: 'lifecycle',
        message: `HTTP lifecycle '${args.type}' delivery failed: ${error instanceof Error ? error.message : 'unknown'}`,
        payload: { eventType: args.type },
      })
    } catch {
      // never fail the caller, not even on the audit write
    }
  }
}
