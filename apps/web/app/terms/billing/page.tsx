import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import Link from 'next/link'

export const metadata = { title: 'Billing Terms' }

export default function BillingTermsPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl flex-1 px-6 py-16">
        <p className="text-sm text-zinc-500">
          <Link href="/terms" className="underline">
            Terms
          </Link>
          {' / '}
          Billing
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Hitly Cloud Billing Terms</h1>
        <p className="mt-4 text-sm text-zinc-500">Last updated 17 August 2026.</p>

        <div className="mt-8 space-y-6 text-zinc-600 dark:text-zinc-400">
          <p>
            Hitly Cloud is a paid hosted service billed in USD through Stripe. Solo is free. Pro and
            Team are monthly subscriptions that renew until cancelled. Enterprise is sold by
            arrangement, not self-serve checkout.
          </p>
          <p>
            Starting a paid plan charges the list price today and on each renewal. You authorize Stripe
            to charge the payment method on file.
          </p>
          <p>
            <strong className="font-medium text-zinc-900 dark:text-zinc-100">Upgrades</strong> take
            effect immediately. Unused time on the old plan is credited against the new plan for the
            rest of the current period; you pay the difference now. Your renewal date does not change.
          </p>
          <p>
            <strong className="font-medium text-zinc-900 dark:text-zinc-100">Downgrades</strong>{' '}
            (including return to Solo) take effect at the end of the current period. You keep the
            higher plan until then. We do not refund the unused portion.
          </p>
          <p>
            Cancelling stops renewal. Access continues until period end, then the workspace returns to
            Solo limits (including approval caps and shorter retention).
          </p>
          <p>
            Failed payments: Stripe retries. We may restrict the workspace if the invoice remains
            unpaid.
          </p>
          <p>
            Usage over plan caps may be refused until the next cycle or an upgrade. Unused approvals
            do not roll over.
          </p>
          <p>
            Taxes may be added where required. Receipts and invoices are issued by Stripe.
          </p>
          <p>
            These billing terms sit alongside the general{' '}
            <Link href="/terms" className="underline">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="underline">
              Privacy
            </Link>{' '}
            policy.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}
