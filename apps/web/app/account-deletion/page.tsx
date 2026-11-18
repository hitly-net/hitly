import { LegalDoc } from '@/components/marketing/legal-doc'
import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'
import { marketingMeta } from '@/lib/site'

export const metadata = marketingMeta({
  title: 'Account deletion and data requests',
  description:
    'How to delete your HITLy™ Cloud account, export your data, and make a data request.',
  path: 'account-deletion',
})

export default function AccountdeletionPage() {
  return (
    <>
      <SiteHeader />
      <LegalDoc file="account-deletion" />
      <SiteFooter />
    </>
  )
}
