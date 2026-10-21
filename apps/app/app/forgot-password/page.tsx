import { AuthLayout } from '@/components/auth-layout'
import { ForgotPasswordForm } from '@/components/forgot-password-form'

export const metadata = { title: 'Forgot password' }

export default function ForgotPasswordPage() {
  return (
    <AuthLayout title="Reset password">
      <ForgotPasswordForm />
    </AuthLayout>
  )
}
