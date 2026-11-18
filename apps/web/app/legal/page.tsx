import { LegalDoc } from '@/components/marketing/legal-doc'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Legal notice',
  description:
    'Who runs HITLy™, how to contact us, trade marks and the site legal pages.',
  path: 'legal',
})

export default function LegalPage() {
  return (
    <>
      <SiteHeader />
      <LegalDoc file="legal-notice" />
      <SiteFooter />
    </>
  )
}
