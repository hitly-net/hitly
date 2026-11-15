import { and, eq } from 'drizzle-orm'
import { isProjectStatus, type ProjectStatus, type WorkspaceRole } from '@hitly/core'
import { projects } from '@hitly/db/schema'
import { can } from './tier-entitlements'
import { logProjectEvent } from './events'
import { canManageWorkspace } from './rbac'
import { requireDb, requireTenantWorkspaceId } from './tenant'

/** Exact ingest/decide error string for a paused project. */
export const PROJECT_PAUSED_ERROR = 'project paused'
/** Exact ingest/decide error string for an archived project. */
export const PROJECT_ARCHIVED_ERROR = 'project archived'
export const PROJECT_PAUSED_CODE = 'project_paused'
export const PROJECT_ARCHIVED_CODE = 'project_archived'
export const PROJECT_NOT_ARCHIVED_CODE = 'project_not_archived'
export const PROJECT_NAME_MISMATCH_CODE = 'name_mismatch'
export const PROJECT_LIFECYCLE_UNAVAILABLE_CODE = 'lifecycle_unavailable'

export type ProjectLifecycleError = {
  ok: false
  error: string
  code: string
  status: 400 | 403 | 404 | 409
}

type WorkspacePlanRef = { id: string; plan: string }

type LifecycleCheck = (workspace: WorkspacePlanRef) => boolean | Promise<boolean>

let lifecycleOverride: LifecycleCheck | null = null

/**
 * Whether pause/archive are available for this workspace. Direct delete with
 * a typed project-name confirm is the fallback when this returns false.
 *
 * Read from the tier entitlements map (feature `project_lifecycle`, seeded
 * for every plan) — moving it behind a paid plan is one UPDATE against
 * tier_entitlements, never a code change.
 */
export async function canUseProjectLifecycle(workspace: WorkspacePlanRef): Promise<boolean> {
  if (lifecycleOverride) return lifecycleOverride(workspace)
  return can(workspace, 'project_lifecycle')
}

/** Test-only seam. Production never sets this; `null` restores the DB map. */
export function setCanUseProjectLifecycleForTests(fn: LifecycleCheck | null): void {
  lifecycleOverride = fn
}

export function ingestBlockedForProjectStatus(status: string): ProjectLifecycleError | null {
  if (status === 'paused') {
    return { ok: false, error: PROJECT_PAUSED_ERROR, code: PROJECT_PAUSED_CODE, status: 409 }
  }
  if (status === 'archived') {
    return { ok: false, error: PROJECT_ARCHIVED_ERROR, code: PROJECT_ARCHIVED_CODE, status: 409 }
  }
  return null
}

export function mutationBlockedForProjectStatus(status: string): ProjectLifecycleError | null {
  if (status === 'archived') {
    return { ok: false, error: PROJECT_ARCHIVED_ERROR, code: PROJECT_ARCHIVED_CODE, status: 409 }
  }
  return null
}

export async function loadWorkspaceProject(projectId: string) {
  const workspaceId = requireTenantWorkspaceId()
  const rows = await requireDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  return rows[0] ?? null
}

export async function mutationBlockedForProjectId(projectId: string): Promise<ProjectLifecycleError | null> {
  const project = await loadWorkspaceProject(projectId)
  if (!project) return null
  return mutationBlockedForProjectStatus(project.status)
}

function forbidden(): ProjectLifecycleError {
  return { ok: false, error: 'Forbidden', code: 'forbidden', status: 403 }
}

function notFound(): ProjectLifecycleError {
  return { ok: false, error: 'Not found', code: 'not_found', status: 404 }
}

async function requireAdminProject(
  projectId: string,
  workspaceRole: WorkspaceRole,
): Promise<{ ok: true; project: typeof projects.$inferSelect } | ProjectLifecycleError> {
  if (!canManageWorkspace(workspaceRole)) return forbidden()
  const project = await loadWorkspaceProject(projectId)
  if (!project) return notFound()
  return { ok: true, project }
}

export async function setProjectStatus(args: {
  projectId: string
  status: ProjectStatus
  workspaceRole: WorkspaceRole
  workspace: WorkspacePlanRef
}): Promise<{ ok: true; status: ProjectStatus } | ProjectLifecycleError> {
  if (!isProjectStatus(args.status)) {
    return { ok: false, error: 'Invalid project status', code: 'invalid_status', status: 400 }
  }
  const loaded = await requireAdminProject(args.projectId, args.workspaceRole)
  if (!loaded.ok) return loaded
  if (!(await canUseProjectLifecycle(args.workspace))) {
    return {
      ok: false,
      error: 'Project pause and archive are not available on this plan',
      code: PROJECT_LIFECYCLE_UNAVAILABLE_CODE,
      status: 403,
    }
  }
  const project = loaded.project
  if (project.status === args.status) return { ok: true, status: project.status }
  if (project.status === 'archived' && args.status === 'paused') {
    return {
      ok: false,
      error: PROJECT_ARCHIVED_ERROR,
      code: PROJECT_ARCHIVED_CODE,
      status: 409,
    }
  }
  const workspaceId = requireTenantWorkspaceId()
  await requireDb()
    .update(projects)
    .set({ status: args.status, updatedAt: new Date() })
    .where(and(eq(projects.id, project.id), eq(projects.workspaceId, workspaceId)))
  await logProjectEvent({
    workspaceId,
    projectId: project.id,
    type: 'lifecycle',
    message: `Project status changed from ${project.status} to ${args.status}`,
    payload: { from: project.status, to: args.status },
  })
  return { ok: true, status: args.status }
}

/**
 * Delete a project. Child rows (items, keys, rules, channels, events,
 * decisions, evidence) cascade in the same tenant transaction.
 *
 * When pause/archive are available, the project must already be archived.
 * When they are not, this is the direct-delete path and `confirmName` must
 * match the project name.
 */
export async function deleteProject(args: {
  projectId: string
  workspaceRole: WorkspaceRole
  workspace: WorkspacePlanRef
  confirmName: string
}): Promise<{ ok: true } | ProjectLifecycleError> {
  const loaded = await requireAdminProject(args.projectId, args.workspaceRole)
  if (!loaded.ok) return loaded
  const project = loaded.project
  const lifecycle = await canUseProjectLifecycle(args.workspace)
  if (lifecycle) {
    if (project.status !== 'archived') {
      return {
        ok: false,
        error: 'Project must be archived before it can be deleted',
        code: PROJECT_NOT_ARCHIVED_CODE,
        status: 409,
      }
    }
  } else if (args.confirmName.trim() !== project.name) {
    return {
      ok: false,
      error: 'Project name does not match',
      code: PROJECT_NAME_MISMATCH_CODE,
      status: 400,
    }
  }
  if (lifecycle && args.confirmName.trim() && args.confirmName.trim() !== project.name) {
    return {
      ok: false,
      error: 'Project name does not match',
      code: PROJECT_NAME_MISMATCH_CODE,
      status: 400,
    }
  }
  const workspaceId = requireTenantWorkspaceId()
  // withTenant already wraps this in a transaction. Deleting the project
  // row cascades to memberships, keys, rules, channels, events, approvals,
  // decision records, and evidence receipts.
  await requireDb()
    .delete(projects)
    .where(and(eq(projects.id, project.id), eq(projects.workspaceId, workspaceId)))
  return { ok: true }
}
