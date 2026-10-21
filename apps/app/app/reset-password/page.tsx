import { AuthLayout } from '@/components/auth-layout'
import { ResetPasswordForm } from '@/components/reset-password-form'
import { auth } from '@/lib/auth'
import { checkResetToken, resolveResetPageToken } from '@/lib/reset-token-check'

export const metadata = { title: 'Set a new password' }

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>
}) {
  const params = await searchParams
  const token = await resolveResetPageToken(params, auth ? (value) => checkResetToken(auth!, value) : null)
  return (
    <AuthLayout title="Set a new password">
      <ResetPasswordForm token={token} />
    </AuthLayout>
  )
}
