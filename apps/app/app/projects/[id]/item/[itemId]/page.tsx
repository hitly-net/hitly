import { WorkItemDetail } from '@/components/work-item-detail'

export const metadata = { title: 'Work item' }

export default async function ProjectItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; itemId: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { id, itemId } = await params
  const search = await searchParams
  return <WorkItemDetail approvalId={itemId} projectId={id} errorMessage={typeof search.error === 'string' ? search.error : undefined} />
}
