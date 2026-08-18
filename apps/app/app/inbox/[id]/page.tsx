import { WorkItemDetail } from '@/components/work-item-detail'

export const metadata = { title: 'Work item' }

export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { id } = await params
  const search = await searchParams
  return <WorkItemDetail approvalId={id} errorMessage={typeof search.error === 'string' ? search.error : undefined} />
}
