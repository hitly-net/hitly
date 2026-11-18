import { LegalDoc } from '@/components/marketing/legal-doc'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Subprocessors',
  description:
    'The HITLy™ Cloud subprocessor list, with 30-day change notice, self-hosted components and non-subprocessor vendors.',
  path: 'subprocessors',
})

export default function SubprocessorsPage() {
  return (
    <>
      <SiteHeader />
      <LegalDoc file="subprocessors" />
      <SiteFooter />
    </>
  )
}
