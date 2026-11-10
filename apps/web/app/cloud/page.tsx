import { CloudPlaceholder } from '@/components/marketing/cloud-placeholder'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Cloud',
  robots: { index: false, follow: false },
}

export default function CloudPage() {
  return <CloudPlaceholder />
}
