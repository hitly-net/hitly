import { and, eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { projectRules } from '@hitly/db/schema'
import { createProjectRule, deleteProjectRule } from '@/actions/projects'
import { AppShell } from '@/components/app-shell'
import { ProjectTabs } from '@/components/project-tabs'
import { canAdminProject } from '@/lib/rbac'
import { requireVisibleProject } from '@/lib/project-page'
import { requireDb, requireTenantWorkspaceId } from '@/lib/tenant'
import { withAppTenant } from '@/lib/context'

export const metadata = { title: 'Rules' }

export default async function ProjectRulesPage({ params }: { params: Promise<{ id: string }> }) {
  return withAppTenant(async () => {
  const { id } = await params
  const { project, access } = await requireVisibleProject(id)
  if (!canAdminProject(access)) redirect(`/projects/${id}`)
  const rules = await requireDb()
    .select()
    .from(projectRules)
    .where(and(eq(projectRules.projectId, id), eq(projectRules.workspaceId, requireTenantWorkspaceId())))

  return (
    <AppShell project={{ id: project.id, name: project.name }}>
      <h1 className="text-2xl font-semibold">{project.name}</h1>
      <ProjectTabs projectId={id} current="Rules" />
      <p className="mt-4 text-sm text-zinc-500">
        First matching rule wins. Assignee overrides are ignored until team routing; SLA and channel still apply.
      </p>

      <form action={createProjectRule.bind(null, id)} className="mt-6 grid max-w-xl gap-2">
        <input
          name="name"
          required
          placeholder="Rule name"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          name="actionName"
          placeholder="Match action name (glob, e.g. send-*)"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          name="workflowId"
          placeholder="Match workflow id"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          name="slaMinutes"
          type="number"
          placeholder="SLA minutes (optional)"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          name="priority"
          type="number"
          defaultValue={100}
          placeholder="Priority (lower runs first)"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Add rule
        </button>
      </form>

      <ul className="mt-8 max-w-xl divide-y divide-zinc-200 dark:divide-zinc-800">
        {rules.length === 0 ? (
          <li className="text-sm text-zinc-500">No rules. Default SLA and email channel apply.</li>
        ) : (
          rules.map((rule) => (
            <li key={rule.id} className="flex items-start justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">
                  {rule.name}{' '}
                  <span className="font-normal text-zinc-500">priority {rule.priority}</span>
                </p>
                <p className="mt-1 font-mono text-xs text-zinc-500">{JSON.stringify(rule.match)}</p>
                <p className="font-mono text-xs text-zinc-500">{JSON.stringify(rule.actions)}</p>
              </div>
              <form action={deleteProjectRule.bind(null, id, rule.id)}>
                <button type="submit" className="text-xs text-zinc-500 hover:text-red-600">
                  Delete
                </button>
              </form>
            </li>
          ))
        )}
      </ul>
    </AppShell>
  )
  })
}
