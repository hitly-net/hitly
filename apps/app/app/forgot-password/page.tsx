import { AuthForm } from '@/components/auth-form'
import { AuthLayout } from '@/components/auth-layout'

export const metadata = { title: 'Forgot password' }

export default function ForgotPasswordPage() {
  return (
    <AuthLayout title="Reset password">
      <AuthForm action="/api/auth/forget-password" submitLabel="Send reset email" />
    </AuthLayout>
  )
}
