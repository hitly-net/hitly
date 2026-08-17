import { AppShell } from '@/components/app-shell'
import { BillingSettings } from '@hitly/cloud/pages/billing'
import { countApprovalsThisMonth } from '@/lib/approvals'
import { getAppContext, getWorkspaceRecord } from '@/lib/context'

export const metadata = { title: 'Billing' }

export default async function BillingPage() {
  const { workspace } = await getAppContext()
  const record = await getWorkspaceRecord(workspace.id)
  const usedApprovals = await countApprovalsThisMonth(workspace.id)

  return (
    <AppShell>
      <BillingSettings
        workspaceId={workspace.id}
        plan={workspace.plan}
        usedApprovals={usedApprovals}
        stripeCustomerId={record?.stripeCustomerId ?? null}
      />
    </AppShell>
  )
}
