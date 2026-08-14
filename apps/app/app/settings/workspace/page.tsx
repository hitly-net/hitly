import { updateWorkspace } from '@/actions/workspace'
import { AppShell } from '@/components/app-shell'
import { getAppContext, getWorkspaceRecord } from '@/lib/context'
import { canManageWorkspace } from '@/lib/rbac'

export const metadata = { title: 'Workspace' }

export default async function WorkspacePage() {
  const { workspace, role } = await getAppContext()
  const record = await getWorkspaceRecord(workspace.id)
  const admin = canManageWorkspace(role)

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Workspace</h1>
      <p className="mt-2 text-sm text-zinc-500">Name, timezone, and the default SLA for work items in this workspace.</p>
      <form action={updateWorkspace} className="mt-6 flex max-w-md flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-500">Name</span>
          <input
            name="name"
            defaultValue={record?.name ?? workspace.name}
            disabled={!admin}
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">Shown in the header switcher and team settings.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-500">Timezone</span>
          <input
            name="timezone"
            defaultValue={record?.timezone ?? 'UTC'}
            disabled={!admin}
            placeholder="UTC"
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">IANA timezone for displaying times, for example UTC or Europe/London.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-500">Default SLA (minutes)</span>
          <input
            name="sla"
            defaultValue={record?.defaultSlaMinutes ?? '60'}
            disabled={!admin}
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">
            How long a work item stays open before it expires. Projects can override this.
          </span>
        </label>
        {admin ? (
          <button
            type="submit"
            className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Save
          </button>
        ) : (
          <p className="text-sm text-zinc-500">Only workspace admins can edit these settings.</p>
        )}
      </form>
    </AppShell>
  )
}
