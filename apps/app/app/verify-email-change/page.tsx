import { AuthLayout } from '@/components/auth-layout'
import { ConfirmEmailChangeForm } from '@/components/confirm-email-change-form'

export const metadata = { title: 'Confirm email change', referrer: 'no-referrer' }

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

/**
 * GET (and HEAD / prefetch) only renders the Confirm button. The token from
 * the emailed link is passed to the form; it is consumed only by a
 * same-origin JSON POST to /api/session/verify-email-change.
 */
export default async function VerifyEmailChangePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>
}) {
  const token = first((await searchParams).token) ?? ''
  return (
    <AuthLayout title="Confirm email change">
      <ConfirmEmailChangeForm token={token} />
    </AuthLayout>
  )
}
