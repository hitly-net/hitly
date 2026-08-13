import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Workspace' }

export default function WorkspacePage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Workspace</h1>
      <form className="mt-6 flex max-w-md flex-col gap-3">
        <input name="name" placeholder="Workspace name" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <input name="timezone" placeholder="Timezone" defaultValue="UTC" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <input name="sla" placeholder="Default SLA (minutes)" defaultValue="60" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <button type="button" className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          Save
        </button>
      </form>
    </AppShell>
  )
}
