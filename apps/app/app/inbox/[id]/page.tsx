import { WorkItemDetail } from '@/components/work-item-detail'

export const metadata = { title: 'Work item' }

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <WorkItemDetail approvalId={id} />
}
