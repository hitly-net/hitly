import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Notifications' }

export default function NotificationsPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Notifications</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Per-project channels live on each project. Email is the OSS default; Slack and Telegram come later.
      </p>
    </AppShell>
  )
}
