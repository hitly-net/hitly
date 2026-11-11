import { CloudPlaceholder } from '@/components/marketing/cloud-placeholder'
import { cloudMetadata } from './metadata'

export const dynamic = 'force-dynamic'

export const metadata = cloudMetadata

export default function CloudPage() {
  return <CloudPlaceholder />
}
