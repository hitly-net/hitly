import { AppShell } from '@/components/app-shell'
import { DataRequestButton } from '@/components/data-request-button'
import { ThemePicker } from '@/components/theme-picker'
import { UnverifiedEmailNotice } from '@/components/unverified-email-notice'
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
        <UnverifiedEmailNotice verified={user.emailVerified} />
      </div>
      <h2 className="mt-10 text-lg font-semibold">Theme</h2>
      <p className="mt-1 text-sm text-zinc-500">Saved in this browser. System follows your OS appearance.</p>
      <div className="mt-3">
        <ThemePicker />
      </div>
      <h2 className="mt-10 text-lg font-semibold">Your data</h2>
      <p className="mt-1 max-w-md text-sm text-zinc-500">
        Ask support for a copy of your personal data. Support prepares the export and sends it to your
        account email; under UK GDPR you will receive it within one month. Account deletion will be offered
        from this page.
      </p>
      <div className="mt-3">
        <DataRequestButton />
      </div>
    </AppShell>
  )
}
