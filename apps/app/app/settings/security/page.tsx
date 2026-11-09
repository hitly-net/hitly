import { AppShell } from '@/components/app-shell'
import { ChangeEmailForm } from '@/components/change-email-form'
import { ChangePasswordForm } from '@/components/change-password-form'
import { requireSessionUser } from '@/lib/context'

export const metadata = { title: 'Security' }

export default async function SecurityPage() {
  await requireSessionUser()
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Security</h1>
      <h2 className="mt-6 text-lg font-semibold">Email</h2>
      <p className="mt-1 text-sm text-zinc-500">
        We will email a confirmation link to the new address. Your current address stays active until you confirm.
      </p>
      <div className="mt-4">
        <ChangeEmailForm />
      </div>
      <h2 className="mt-10 text-lg font-semibold">Password</h2>
      <div className="mt-4">
        <ChangePasswordForm />
      </div>
      <h2 className="mt-10 text-lg font-semibold">Sessions</h2>
      <p className="mt-2 text-sm text-zinc-500">Active sessions will list here.</p>
    </AppShell>
  )
}
