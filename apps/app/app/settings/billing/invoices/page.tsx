import { AppShell } from '@/components/app-shell'
import { InvoiceList } from '@hitly/cloud/pages/invoices'
import { requireSessionUser } from '@/lib/context'

export const metadata = { title: 'Invoices' }

export default async function InvoicesPage() {
  await requireSessionUser()
  return (
    <AppShell>
      <InvoiceList />
    </AppShell>
  )
}
