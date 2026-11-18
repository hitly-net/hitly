import { LegalDoc } from '@/components/marketing/legal-doc'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Privacy Notice',
  description:
    'Privacy Notice for HITLy™ Cloud: what we collect, why, who processes it, and your rights.',
  path: '/privacy',
})

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <LegalDoc file="privacy" />
      <SiteFooter />
    </>
  )
}
