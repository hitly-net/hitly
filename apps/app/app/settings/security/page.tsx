import { AppShell } from '@/components/app-shell'
import { ChangePasswordForm } from '@/components/change-password-form'
import { requireSessionUser } from '@/lib/context'

export const metadata = { title: 'Security' }

export default async function SecurityPage() {
  await requireSessionUser()
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Security</h1>
      <div className="mt-6">
        <ChangePasswordForm />
      </div>
      <h2 className="mt-10 text-lg font-semibold">Sessions</h2>
      <p className="mt-2 text-sm text-zinc-500">Active sessions will list here.</p>
    </AppShell>
  )
}
