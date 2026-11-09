import { AuthLayout } from '@/components/auth-layout'
import { InviteAccept } from '@/components/invite-accept'

export const metadata = { title: 'Accept invite', referrer: 'no-referrer' }

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return (
    <AuthLayout title="Accept invite">
      <InviteAccept token={token} />
    </AuthLayout>
  )
}
