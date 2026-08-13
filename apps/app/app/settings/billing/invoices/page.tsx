import { AppShell } from '@/components/app-shell'
import { InvoiceList } from '@hitly/cloud/pages/invoices'

export const metadata = { title: 'Invoices' }

export default function InvoicesPage() {
  return (
    <AppShell>
      <InvoiceList />
    </AppShell>
  )
}
