import { isListedPluginId } from '@hitly/core'
import { and, eq } from 'drizzle-orm'
import {
  projectApiKeys,
  projectChannels,
  projectMemberships,
  projects,
  users,
} from '@hitly/db/schema'
import { newId } from './ids'
import { generateApiKey, generateResumeSecret } from './keys'
import { requireDb, requireTenantWorkspaceId } from './tenant'
import { encodeTenantJson } from './tenant-crypto'
import { assertEmailVerifiedForCreate } from './verified-gate'

/**
 * Reads the acting user's CURRENT stored verification flag (never a
 * session-cached copy) and applies the unverified-email gate. Both create
 * helpers call this before any write, so the flag is checked while the
 * tenant transaction is still unwritten.
 */
/** Shared actor gate: used by the create/rotate helpers here and by the resume-secret rotate chokepoint. */
export async function assertCreatorVerified(userId: string) {
  const rows = await requireDb()
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!rows[0]) throw new Error('Account not found')
  assertEmailVerifiedForCreate(rows[0].emailVerified)
}

/**
 * Creates a project in the current tenant workspace, with the creator as
 * project admin and an email channel. Returns the new project id.
 *
 * Only listed plugins can be chosen for a new project. Projects that already
 * use an unlisted plugin (OpenShell) stay valid and are not affected here.
 */
export async function insertNewProject(args: {
  userId: string
  name: unknown
  description: unknown
  plugin: unknown
}): Promise<string> {
  const workspaceId = requireTenantWorkspaceId()
  const name = String(args.name ?? '').trim()
  const description = String(args.description ?? '').trim()
  const plugin = String(args.plugin ?? '')
  if (!name) throw new Error('Name is required')
  if (!isListedPluginId(plugin)) throw new Error('Choose a plugin')
  await assertCreatorVerified(args.userId)

  const database = requireDb()
  const projectId = newId('prj').slice(0, 36)
  await database.insert(projects).values({
    id: projectId,
    workspaceId,
    name,
    description: description || null,
    plugin,
    credentials: await encodeTenantJson(workspaceId, { plugin, resumeSecret: generateResumeSecret() }),
    defaultAssigneeUserId: args.userId,
    defaultSlaMinutes: '1440',
  })
  await database.insert(projectMemberships).values({
    id: newId('pm').slice(0, 36),
    workspaceId,
    projectId,
    userId: args.userId,
    role: 'admin',
  })
  await database.insert(projectChannels).values({
    id: newId('ch').slice(0, 36),
    workspaceId,
    projectId,
    type: 'email',
    config: {},
    enabled: true,
  })
  return projectId
}

/**
 * Creates a project API key in the current tenant workspace. The single
 * server-side path that writes projectApiKeys: the web action calls this,
 * and any present or future REST /api/v1 or MCP create path must go through
 * it too, so the unverified-email gate holds for every caller. Returns the
 * raw key (shown once).
 */
export async function insertNewProjectApiKey(args: {
  projectId: string
  userId: string
  name: unknown
}): Promise<string> {
  const workspaceId = requireTenantWorkspaceId()
  const name = String(args.name ?? '').trim() || 'Ingest key'
  await assertCreatorVerified(args.userId)

  const generated = generateApiKey()
  const database = requireDb()
  await database.insert(projectApiKeys).values({
    id: newId('key').slice(0, 36),
    workspaceId,
    projectId: args.projectId,
    name,
    hashedKey: generated.hashed,
    prefix: generated.prefix,
  })
  return generated.raw
}

/**
 * Rotates an existing project API key in the current tenant workspace:
 * the single server-side path that replaces a stored key secret. The web
 * action calls this, and any present or future REST /api/v1 or MCP
 * regenerate path must go through it too, so the unverified-email gate
 * holds for regeneration exactly as it does for creation. Returns the new
 * raw key (shown once); the old secret stops working at once.
 */
export async function rotateProjectApiKeyRecord(args: {
  projectId: string
  keyId: string
  userId: string
}): Promise<string> {
  const workspaceId = requireTenantWorkspaceId()
  const database = requireDb()
  const scope = and(
    eq(projectApiKeys.id, args.keyId),
    eq(projectApiKeys.projectId, args.projectId),
    eq(projectApiKeys.workspaceId, workspaceId),
  )
  const rows = await database.select({ id: projectApiKeys.id }).from(projectApiKeys).where(scope).limit(1)
  if (!rows[0]) throw new Error('Key not found')
  await assertCreatorVerified(args.userId)

  const generated = generateApiKey()
  await database
    .update(projectApiKeys)
    .set({ hashedKey: generated.hashed, prefix: generated.prefix, lastUsedAt: null })
    .where(scope)
  return generated.raw
}
