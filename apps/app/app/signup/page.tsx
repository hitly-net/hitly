import Link from 'next/link'
import { redirect } from 'next/navigation'
import { SocialAuthButtons } from '@hitly/cloud/auth/buttons'
import { AuthForm } from '@/components/auth-form'
import { AuthLayout } from '@/components/auth-layout'
import { EarlyAccessForm } from '@/components/early-access-form'
import { inviteAcceptPathFromSignup, isSignupEnabled } from '@/lib/signup'

export const metadata = { title: 'Sign up' }

export default async function SignupPage({
  searchParams,
}: {
  searchParams?: Promise<{ invite?: string | string[] }>
}) {
  const invitePath = inviteAcceptPathFromSignup((await searchParams)?.invite)
  if (invitePath) redirect(invitePath)
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
      <p className="mt-3 text-xs text-zinc-500">
        By signing up you agree to the{' '}
        <a
          href="https://hitly.net/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-zinc-900 dark:hover:text-zinc-50"
        >
          Terms
        </a>{' '}
        and{' '}
        <a
          href="https://hitly.net/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-zinc-900 dark:hover:text-zinc-50"
        >
          Privacy Notice
        </a>
        .
      </p>
      <p className="mt-4 text-sm text-zinc-500">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </AuthLayout>
  )
}
