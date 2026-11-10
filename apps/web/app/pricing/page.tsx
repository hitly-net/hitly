import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { PricingTable } from '@/components/marketing/pricing'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Pricing',
  description:
    'HITLy pricing: Solo is free, Pro and Team are monthly Cloud subscriptions, Enterprise by arrangement. Self-hosting the Apache-2.0 server is free with no usage caps.',
  path: '/pricing',
})

export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <PricingTable />
      </main>
      <SiteFooter />
    </>
  )
}
