import { and, eq } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import type { Gate } from '@hitly/mastra-factory-plugin/server'
import { mutationBlockedForProjectStatus } from './project-lifecycle'
import { requireDb, requireTenantWorkspaceId } from './tenant'
import { decodeTenantJson, encodeTenantJson } from './tenant-crypto'

/**
 * Server-side truth for the Mastra Factory integration gates. The Factory-side
 * plugin polls `GET /api/v1/projects/:id/integrations/mastra-factory` (key
 * scoped) for this state; the Config panel is the only writer. Env vars on the
 * Factory host are bootstrap/fallback only — the plugin fails closed to these
 * values when it cannot reach HITLy.
 */
export type MastraFactoryConfig = {
  gates: Record<Gate, boolean>
  mergeAfterAccept: boolean
}

/** Gates default ON; merging on accept is strictly opt-in. */
export const DEFAULT_MASTRA_FACTORY_CONFIG: MastraFactoryConfig = {
  gates: { plan: true, review: true, ask_user: true },
  mergeAfterAccept: false,
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read `credentials.mastraFactory` with defaults for anything missing or malformed. */
export function parseMastraFactoryConfig(credentials: Record<string, unknown>): MastraFactoryConfig {
  const raw = credentials.mastraFactory
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return structuredClone(DEFAULT_MASTRA_FACTORY_CONFIG)
  }
  const record = raw as Record<string, unknown>
  const gates = (record.gates && typeof record.gates === 'object' && !Array.isArray(record.gates)
    ? record.gates
    : {}) as Record<string, unknown>
  return {
    gates: {
      plan: booleanOr(gates.plan, DEFAULT_MASTRA_FACTORY_CONFIG.gates.plan),
      review: booleanOr(gates.review, DEFAULT_MASTRA_FACTORY_CONFIG.gates.review),
      ask_user: booleanOr(gates.ask_user, DEFAULT_MASTRA_FACTORY_CONFIG.gates.ask_user),
    },
    mergeAfterAccept: booleanOr(record.mergeAfterAccept, DEFAULT_MASTRA_FACTORY_CONFIG.mergeAfterAccept),
  }
}

export async function readMastraFactoryConfig(projectId: string): Promise<MastraFactoryConfig | null> {
  const workspaceId = requireTenantWorkspaceId()
  const rows = await requireDb()
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  const project = rows[0]
  if (!project) return null
  const credentials = await decodeTenantJson(workspaceId, project.credentials as Record<string, unknown>)
  return parseMastraFactoryConfig(credentials as Record<string, unknown>)
}

export async function saveMastraFactoryConfig(
  projectId: string,
  input: MastraFactoryConfig,
): Promise<{ error: string; code?: string; status?: number } | undefined> {
  const workspaceId = requireTenantWorkspaceId()
  const database = requireDb()
  const rows = await database
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  const project = rows[0]
  if (!project) return { error: 'Project not found' }
  if (project.plugin !== 'mastra-factory') return { error: 'Project is not a Mastra Factory project' }
  const archived = mutationBlockedForProjectStatus(project.status)
  if (archived) return { error: archived.error, code: archived.code, status: archived.status }
  const current = (await decodeTenantJson(workspaceId, project.credentials as Record<string, unknown>)) as Record<string, unknown>
  const next: Record<string, unknown> = { plugin: project.plugin, ...current }
  next.mastraFactory = {
    gates: {
      plan: booleanOr(input.gates.plan, true),
      review: booleanOr(input.gates.review, true),
      ask_user: booleanOr(input.gates.ask_user, true),
    },
    mergeAfterAccept: booleanOr(input.mergeAfterAccept, false),
  }
  await database
    .update(projects)
    .set({ credentials: await encodeTenantJson(workspaceId, next), updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
  return undefined
}
