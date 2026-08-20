import { AppShell } from '@/components/app-shell'
import { ThemePicker } from '@/components/theme-picker'
import { getAppContext } from '@/lib/context'

export const metadata = { title: 'Profile' }

export default async function ProfilePage() {
  const { user } = await getAppContext()
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Profile</h1>
      <div className="mt-6 flex max-w-md flex-col gap-3 text-sm">
        <p>
          <span className="text-zinc-500">Name</span>
          <br />
          {user.name}
        </p>
        <p>
          <span className="text-zinc-500">Email</span>
          <br />
          {user.email}
        </p>
      </div>
      <h2 className="mt-10 text-lg font-semibold">Theme</h2>
      <p className="mt-1 text-sm text-zinc-500">Saved in this browser. System follows your OS appearance.</p>
      <div className="mt-3">
        <ThemePicker />
      </div>
    </AppShell>
  )
}
