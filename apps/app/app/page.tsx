import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { getAppContext } from '@/lib/context'
import { inboxSummary } from '@/lib/inbox'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>
}) {
  const query = await searchParams
  const projectId = query.projectId?.trim() ?? ''
  const { workspace, user, role } = await getAppContext()
  const summary = await inboxSummary({
    workspaceId: workspace.id,
    userId: user.id,
    workspaceRole: role,
    projectId: projectId || undefined,
  })

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Inbox summary</h1>
      <p className="mt-2 text-sm text-zinc-500">
        {projectId
          ? 'Work items for the selected project in this workspace.'
          : 'Work items across every project in this workspace.'}
      </p>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500">Needs attention</p>
          <p className="mt-2 text-3xl font-semibold">{summary.pending}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500">Decided today</p>
          <p className="mt-2 text-3xl font-semibold">{summary.decidedToday}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500">Projects</p>
          <p className="mt-2 text-3xl font-semibold">{summary.projectCount}</p>
        </div>
      </div>
      <Link
        href={projectId ? `/inbox?projectId=${encodeURIComponent(projectId)}` : '/inbox'}
        className="mt-6 inline-block text-sm font-medium underline"
      >
        Open inbox
      </Link>
    </AppShell>
  )
}
