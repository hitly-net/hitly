import { inArray, asc } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { AppShell } from '@/components/app-shell'
import { ProjectList } from '@/components/project-list'
import { TierUsageMeter } from '@/components/tier-usage-meter'
import { withAppTenant } from '@/lib/context'
import { canManageWorkspace, listArchivedProjects, listVisibleProjectIds } from '@/lib/rbac'
import { requireDb } from '@/lib/tenant'
import { liveProjectCount, tierUsageFor } from '@/lib/tier-enforcement'

export const metadata = { title: 'Projects' }

export default async function ProjectsPage() {
  return withAppTenant(async ({ workspace, role, user }) => {
  const ids = await listVisibleProjectIds({
    workspaceId: workspace.id,
    userId: user.id,
    workspaceRole: role,
  })
  const list =
    ids.length === 0
      ? []
      : await requireDb()
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            plugin: projects.plugin,
            status: projects.status,
          })
          .from(projects)
          .where(inArray(projects.id, ids))
          .orderBy(asc(projects.name))
  const canCreate = canManageWorkspace(role)
  const archived = await listArchivedProjects({ workspaceId: workspace.id, workspaceRole: role })
  // Live-project limit/usage shown where the create/resume actions live.
  const liveProjectsUsage = await tierUsageFor(
    { plan: workspace.plan },
    'live_projects',
    await liveProjectCount(requireDb(), workspace.id),
  )

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-2 text-sm text-zinc-500">Work items, origin credentials, people, rules, channels, and logs.</p>
          <TierUsageMeter title="Live projects" usage={liveProjectsUsage} />
        </div>
      </div>
      <ProjectList projects={list} canCreate={canCreate} upgrade={liveProjectsUsage.upgrade} />
      {archived.length > 0 ? (
        <div className="mt-10">
          <h2 className="text-lg font-semibold">Archived</h2>
          <p className="mt-1 text-sm text-zinc-500">Hidden from the inbox. Unarchive from Config to restore.</p>
          <ProjectList projects={archived} canCreate={false} />
        </div>
      ) : null}
    </AppShell>
  )
  })
}
