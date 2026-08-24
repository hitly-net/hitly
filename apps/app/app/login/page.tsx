import Link from 'next/link'
import { SocialAuthButtons } from '@hitly/cloud/auth/buttons'
import { AuthForm } from '@/components/auth-form'
import { AuthLayout } from '@/components/auth-layout'
import { isSignupEnabled } from '@/lib/signup'

export const metadata = { title: 'Log in' }

export default function LoginPage() {
  const showSignup = isSignupEnabled()

  return (
    <AuthLayout title="Log in">
      <SocialAuthButtons />
      <AuthForm action="/api/auth/sign-in/email" submitLabel="Log in" />
      <p className="mt-4 text-sm text-zinc-500">
        <Link href="/forgot-password">Forgot password</Link>
        {showSignup ? (
          <>
            {' · '}
            <Link href="/signup">Create an account</Link>
          </>
        ) : null}
      </p>
    </AuthLayout>
  )
}
