import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Team' }

export default function TeamPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Team</h1>
      <form className="mt-6 flex max-w-md gap-2">
        <input name="email" type="email" placeholder="Invite email" className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <button type="button" className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          Invite
        </button>
      </form>
    </AppShell>
  )
}
