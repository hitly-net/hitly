import { LegalDoc } from '@/components/marketing/legal-doc'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Data Processing Agreement',
  description:
    'HITLy™ Cloud Data Processing Agreement, with processing, security and subprocessor annexes.',
  path: 'dpa',
})

export default function DpaPage() {
  return (
    <>
      <SiteHeader />
      <LegalDoc file="dpa" />
      <SiteFooter />
    </>
  )
}
