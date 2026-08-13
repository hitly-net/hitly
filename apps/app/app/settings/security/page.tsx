import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Security' }

export default function SecurityPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Security</h1>
      <form className="mt-6 flex max-w-md flex-col gap-3">
        <input name="currentPassword" type="password" placeholder="Current password" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <input name="newPassword" type="password" placeholder="New password" className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <button type="button" className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          Change password
        </button>
      </form>
      <h2 className="mt-10 text-lg font-semibold">Sessions</h2>
      <p className="mt-2 text-sm text-zinc-500">Active sessions will list here.</p>
    </AppShell>
  )
}
