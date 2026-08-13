import { CtaBanner, PricingTable } from '@/components/marketing/pricing'
import { Hero } from '@/components/marketing/hero'
import { HowItWorks } from '@/components/marketing/how-it-works'
import { InboxPreview } from '@/components/marketing/inbox-preview'
import { PluginGrid } from '@/components/marketing/plugin-grid'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <HowItWorks />
        <PluginGrid />
        <InboxPreview />
        <PricingTable />
        <CtaBanner />
      </main>
      <SiteFooter />
    </>
  )
}
