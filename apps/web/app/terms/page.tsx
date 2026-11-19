import { LegalDoc } from '@/components/marketing/legal-doc'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Terms of Service',
  description:
    'HITLy™ Cloud Terms of Service: business use, the service, your data, billing terms, liability and governing law.',
  path: '/terms',
})

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <LegalDoc file="terms" />
      <SiteFooter />
    </>
  )
}
