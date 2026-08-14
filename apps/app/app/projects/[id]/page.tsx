import { Suspense } from 'react'
import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { ProjectTabs } from '@/components/project-tabs'
import { WorkItemFilters } from '@/components/work-item-filters'
import { WorkItemList } from '@/components/work-item-list'
import { listInboxItems } from '@/lib/inbox'
import { parseListFilters, projectItemsFilterStorageKey } from '@/lib/list-filters'
import { requireVisibleProject } from '@/lib/project-page'

export const metadata = { title: 'Project' }

export default async function ProjectItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ scope?: string; q?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const { scope, q } = parseListFilters(query)
  const { project, workspace, user, role } = await requireVisibleProject(id)
  const items = await listInboxItems({
    workspaceId: workspace.id,
    userId: user.id,
    workspaceRole: role,
    projectId: id,
    scope,
    q: q || undefined,
  })
  const filtered = Boolean(q || scope !== 'all')

  return (
    <AppShell project={{ id: project.id, name: project.name }}>
      <h1 className="text-2xl font-semibold">{project.name}</h1>
      <ProjectTabs projectId={id} current="Items" />
      <p className="mt-4 text-sm text-zinc-500">Work items for this project.</p>
      <Suspense>
        <WorkItemFilters
          storageKey={projectItemsFilterStorageKey(id)}
          basePath={`/projects/${id}`}
          scope={scope}
          q={q}
        />
      </Suspense>
      <WorkItemList
        items={items}
        hrefFor={(item) => `/projects/${id}/item/${item.id}`}
        empty={
          <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500">
            {filtered ? (
              'No matching work items.'
            ) : (
              <>
                No work items yet. Ingest from the origin using the API key on{' '}
                <Link href={`/projects/${id}/config`} className="underline">
                  Config
                </Link>
                .
              </>
            )}
          </div>
        }
      />
    </AppShell>
  )
}
