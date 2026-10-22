import { isListedPluginId } from '@hitly/core'
import { projectChannels, projectMemberships, projects } from '@hitly/db/schema'
import { newId } from './ids'
import { generateResumeSecret } from './keys'
import { requireDb, requireTenantWorkspaceId } from './tenant'
import { encodeTenantJson } from './tenant-crypto'

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
    defaultSlaMinutes: '60',
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
