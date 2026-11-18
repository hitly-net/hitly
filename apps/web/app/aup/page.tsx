import { LegalDoc } from '@/components/marketing/legal-doc'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Acceptable Use Policy',
  description:
    'What you may and may not do with HITLy™ Cloud, and how to report abuse.',
  path: 'aup',
})

export default function AupPage() {
  return (
    <>
      <SiteHeader />
      <LegalDoc file="aup" />
      <SiteFooter />
    </>
  )
}
