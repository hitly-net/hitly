import { AuthLayout } from '@/components/auth-layout'
import { ConfirmEmailVerificationForm } from '@/components/confirm-email-verification-form'

export const metadata = { title: 'Verify email', referrer: 'no-referrer' }

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

/**
 * GET (and HEAD / prefetch) only renders the Confirm button. The token from
 * the emailed link is passed to the form; it is consumed only by a
 * same-origin JSON POST to /api/session/verify-email.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const token = first((await searchParams).token) ?? ''
  return (
    <AuthLayout title="Verify your email">
      {token ? (
        <ConfirmEmailVerificationForm token={token} />
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Open the verification link from your email, then press Confirm. You can keep using HITLy in the meantime.
        </p>
      )}
    </AuthLayout>
  )
}
