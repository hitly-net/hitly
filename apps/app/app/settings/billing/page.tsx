import { AppShell } from '@/components/app-shell'
import { BillingSettings } from '@hitly/cloud/pages/billing'

export const metadata = { title: 'Billing' }

export default function BillingPage() {
  return (
    <AppShell>
      <BillingSettings />
    </AppShell>
  )
}
