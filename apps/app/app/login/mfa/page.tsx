import { AuthLayout } from '@/components/auth-layout'
import { MfaVerifyForm } from '@/components/mfa-verify-form'

export const metadata = { title: 'Two-step verification' }

export default function MfaVerifyPage() {
  return (
    <AuthLayout title="Two-step verification">
      <MfaVerifyForm />
    </AuthLayout>
  )
}
