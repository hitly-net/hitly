import { headers } from 'next/headers'
import { AuthLayout } from '@/components/auth-layout'
import { ResetPasswordForm } from '@/components/reset-password-form'
import { auth } from '@/lib/auth'
import { resetCheckClientKey } from '@/lib/reset-check-limit'
import { loadResetPageState } from '@/lib/reset-token-check'

export const metadata = { title: 'Set a new password', referrer: 'no-referrer' }

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>
}) {
  const params = await searchParams
  const state = await loadResetPageState(params, { auth, clientKey: resetCheckClientKey(await headers()) })
  return (
    <AuthLayout title="Set a new password">
      <ResetPasswordForm state={state} />
    </AuthLayout>
  )
}
