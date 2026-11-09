import { AuthLayout } from '@/components/auth-layout'
import { EMAIL_CHANGED_MESSAGE, VERIFY_EMAIL_CHANGE_INVALID_MESSAGE } from '@/lib/email-change'
import { handleEmailChangeVerify } from '@/lib/email-change-route'

export const metadata = { title: 'Confirm email change', referrer: 'no-referrer' }

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function VerifyEmailChangePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const token = first((await searchParams).token) ?? ''
  const result = await handleEmailChangeVerify(token)
  const ok = result.status === 200
  return (
    <AuthLayout title={ok ? 'Email updated' : 'Link invalid'}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {ok ? EMAIL_CHANGED_MESSAGE : VERIFY_EMAIL_CHANGE_INVALID_MESSAGE}
      </p>
    </AuthLayout>
  )
}
