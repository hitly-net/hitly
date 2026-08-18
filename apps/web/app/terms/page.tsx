import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import Link from 'next/link'

export const metadata = { title: 'Terms' }

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl flex-1 px-6 py-16">
        <h1 className="text-3xl font-semibold">Terms</h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          Hitly Cloud is a hosted approval inbox. You can also self-host the Apache-2.0 server with no
          usage caps. You are responsible for the workflows you connect and the decisions your
          reviewers make.
        </p>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          Paid Cloud plans, upgrades, downgrades, cancellation, and invoices are described in the{' '}
          <Link href="/terms/billing" className="underline">
            Billing Terms
          </Link>
          . Privacy practices are described in the{' '}
          <Link href="/privacy" className="underline">
            Privacy
          </Link>{' '}
          policy.
        </p>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          These terms are a product summary. Counsel should review them before you rely on them for a
          live paid launch.
        </p>
      </main>
      <SiteFooter />
    </>
  )
}
