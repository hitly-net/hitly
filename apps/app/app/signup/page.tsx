import Link from 'next/link'
import { SocialAuthButtons } from '@hitly/cloud/auth/buttons'
import { AuthForm } from '@/components/auth-form'
import { AuthLayout } from '@/components/auth-layout'
import { EarlyAccessForm } from '@/components/early-access-form'
import { isSignupEnabled } from '@/lib/signup'

export const metadata = { title: 'Sign up' }

export default function SignupPage() {
  if (!isSignupEnabled()) {
    return (
      <AuthLayout title="HITLy Cloud">
        <EarlyAccessForm />
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Create an account">
      <SocialAuthButtons />
      <AuthForm action="/api/auth/sign-up/email" submitLabel="Sign up" extraFields="name" />
      <p className="mt-4 text-sm text-zinc-500">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </AuthLayout>
  )
}
