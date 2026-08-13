import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Notifications' }

export default function NotificationsPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Notifications</h1>
      <label className="mt-6 flex items-center gap-2 text-sm">
        <input type="checkbox" defaultChecked /> Email me when an approval is waiting
      </label>
    </AppShell>
  )
}
