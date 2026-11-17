import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { PricingTable } from '@/components/marketing/pricing'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Pricing',
  description:
    'HITLy pricing: Free plan, Pro is a self-serve Cloud subscription (monthly or annual), Team and Enterprise by arrangement. Self-hosting the Apache-2.0 server is free with no usage caps.',
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
