import { WorkItemDetail } from '@/components/work-item-detail'

export const metadata = { title: 'Work item' }

export default async function ProjectItemPage({
  params,
}: {
  params: Promise<{ id: string; itemId: string }>
}) {
  const { id, itemId } = await params
  return <WorkItemDetail approvalId={itemId} projectId={id} />
}
