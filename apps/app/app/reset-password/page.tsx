import { AuthLayout } from '@/components/auth-layout'
import { ResetPasswordForm } from '@/components/reset-password-form'

export const metadata = { title: 'Set a new password' }

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>
}) {
  const params = await searchParams
  const token = typeof params.token === 'string' && params.token && !params.error ? params.token : null
  return (
    <AuthLayout title="Set a new password">
      <ResetPasswordForm token={token} />
    </AuthLayout>
  )
}
