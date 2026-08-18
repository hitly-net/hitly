import { inArray, asc } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { AppShell } from '@/components/app-shell'
import { ProjectList } from '@/components/project-list'
import { getAppContext, withAppTenant } from '@/lib/context'
import { canManageWorkspace, listVisibleProjectIds } from '@/lib/rbac'
import { requireDb } from '@/lib/tenant'

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
          })
          .from(projects)
          .where(inArray(projects.id, ids))
          .orderBy(asc(projects.name))
  const canCreate = canManageWorkspace(role)

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-2 text-sm text-zinc-500">Work items, origin credentials, people, rules, channels, and logs.</p>
        </div>
      </div>
      <ProjectList projects={list} canCreate={canCreate} />
    </AppShell>
  )
  })
}
