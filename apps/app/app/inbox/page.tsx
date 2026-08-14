import { Suspense } from 'react'
import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { WorkItemFilters } from '@/components/work-item-filters'
import { WorkItemList } from '@/components/work-item-list'
import { getAppContext } from '@/lib/context'
import { listInboxItems } from '@/lib/inbox'
import { inboxFilterStorageKey, parseListFilters } from '@/lib/list-filters'

export const metadata = { title: 'Inbox' }

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; q?: string; projectId?: string }>
}) {
  const query = await searchParams
  const { scope, q, projectId } = parseListFilters(query)
  const { workspace, user, role } = await getAppContext()
  const items = await listInboxItems({
    workspaceId: workspace.id,
    userId: user.id,
    workspaceRole: role,
    scope,
    q: q || undefined,
    projectId,
  })
  const filtered = Boolean(q || scope !== 'all' || projectId)

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Inbox</h1>
      <p className="mt-2 text-sm text-zinc-500">
        {projectId
          ? 'Work items for the selected project, newest first.'
          : 'Work items from all projects in this workspace, newest first.'}
      </p>
      <Suspense>
        <WorkItemFilters
          storageKey={inboxFilterStorageKey(workspace.id)}
          basePath="/inbox"
          scope={scope}
          q={q}
          projectId={projectId}
        />
      </Suspense>
      <WorkItemList
        items={items}
        showProjectName
        hrefFor={(item) => `/inbox/${item.id}`}
        empty={
          <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500">
            {filtered ? (
              'No matching work items.'
            ) : (
              <>
                No work items yet. Create a{' '}
                <Link href="/projects" className="underline">
                  project
                </Link>{' '}
                and ingest from Mastra.
              </>
            )}
          </div>
        }
      />
    </AppShell>
  )
}
