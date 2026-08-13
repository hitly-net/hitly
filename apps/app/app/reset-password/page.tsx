import { AuthForm } from '@/components/auth-form'
import { AuthLayout } from '@/components/auth-layout'

export const metadata = { title: 'Set a new password' }

export default function ResetPasswordPage() {
  return (
    <AuthLayout title="Set a new password">
      <AuthForm action="/api/auth/reset-password" submitLabel="Update password" extraFields="token" />
    </AuthLayout>
  )
}
