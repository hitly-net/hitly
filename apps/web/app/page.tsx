import { ComingSoon } from '@/components/marketing/coming-soon'
import { FeatureBlocks } from '@/components/marketing/feature-blocks'
import { HowItWorks } from '@/components/marketing/how-it-works'
import { PluginGrid } from '@/components/marketing/plugin-grid'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  description:
    'HITLy is the approval inbox for agent work. Mastra, Hermes, HTTP, LangGraph, and Temporal origins pause; reviewers decide in HITLy; plugins resume the run. Self-host Apache-2.0 today; Cloud is waitlist-only.',
  path: '/',
})

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <ComingSoon />
        <HowItWorks />
        <FeatureBlocks />
        <PluginGrid />
      </main>
      <SiteFooter />
    </>
  )
}
