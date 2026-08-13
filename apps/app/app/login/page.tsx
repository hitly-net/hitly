import Link from 'next/link'
import { AuthForm } from '@/components/auth-form'
import { AuthLayout } from '@/components/auth-layout'

export const metadata = { title: 'Log in' }

export default function LoginPage() {
  return (
    <AuthLayout title="Log in">
      <AuthForm action="/api/auth/sign-in/email" submitLabel="Log in" />
      <p className="mt-4 text-sm text-zinc-500">
        <Link href="/forgot-password">Forgot password</Link>
        {' · '}
        <Link href="/signup">Create an account</Link>
      </p>
    </AuthLayout>
  )
}
