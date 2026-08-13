import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { PricingTable } from '@/components/marketing/pricing'

export const metadata = { title: 'Pricing' }

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
