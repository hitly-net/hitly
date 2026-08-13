import { AuthLayout } from '@/components/auth-layout'

export const metadata = { title: 'Verify email' }

export default function VerifyEmailPage() {
  return (
    <AuthLayout title="Verify your email">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Check your inbox for a verification link. You can close this tab after you confirm.
      </p>
    </AuthLayout>
  )
}
