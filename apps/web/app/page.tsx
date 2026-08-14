import { ComingSoon } from '@/components/marketing/coming-soon'
import { HowItWorks } from '@/components/marketing/how-it-works'
import { PluginGrid } from '@/components/marketing/plugin-grid'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <ComingSoon />
        <HowItWorks />
        <PluginGrid />
      </main>
      <SiteFooter />
    </>
  )
}
