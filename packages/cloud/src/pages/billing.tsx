export type BillingSettingsProps = {
  workspaceId: string
  plan: string
  usedApprovals: number
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
}

export function BillingSettings(_props: BillingSettingsProps) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Billing</h1>
      <div className="mt-6 max-w-md rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <p className="text-sm text-zinc-500">Edition</p>
        <p className="mt-1 text-2xl font-semibold">Self-hosted</p>
        <p className="mt-2 text-sm text-zinc-500">
          The open-source server has no usage caps and no Stripe billing. Hosted plans live on
          hitly.net.
        </p>
      </div>
    </>
  )
}
