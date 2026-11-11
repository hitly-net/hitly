import { AppShell } from '@/components/app-shell'
import { ChangeEmailForm } from '@/components/change-email-form'
import { ChangePasswordForm } from '@/components/change-password-form'
import { MfaSetup } from '@/components/mfa-setup'
import { PasskeySetup } from '@/components/passkey-setup'
import { requireSessionUser } from '@/lib/context'
import { getMfaStatus } from '@/lib/mfa-route'
import { listPasskeysForUser } from '@/lib/passkey-route'

export const metadata = { title: 'Security' }

export default async function SecurityPage() {
  const user = await requireSessionUser()
  const mfa = await getMfaStatus(user.id)
  const passkeys = await listPasskeysForUser(user.id)
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
      <h2 className="mt-10 text-lg font-semibold">Authenticator app</h2>
      <div className="mt-4">
        <MfaSetup status={mfa} />
      </div>
      <h2 className="mt-10 text-lg font-semibold">Passkeys</h2>
      <div className="mt-4">
        <PasskeySetup passkeys={passkeys} />
      </div>
      <h2 className="mt-10 text-lg font-semibold">Sessions</h2>
      <p className="mt-2 text-sm text-zinc-500">Active sessions will list here.</p>
    </AppShell>
  )
}
