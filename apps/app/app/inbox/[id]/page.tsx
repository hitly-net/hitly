import { Badge, PluginBadge } from '@hitly/ui'
import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Approval' }

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <AppShell>
      <div className="flex items-center gap-2">
        <PluginBadge plugin="mastra" />
        <Badge variant="warning">pending</Badge>
      </div>
      <h1 className="mt-4 text-2xl font-semibold">Approval {id}</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Context and args from the origin envelope will render here. Decision bar is gated by
        allowedActions.
      </p>
      <div className="mt-6 flex gap-2">
        <button className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          Accept
        </button>
        <button className="rounded-md border border-zinc-200 px-4 py-2 text-sm dark:border-zinc-700">Edit</button>
        <button className="rounded-md border border-zinc-200 px-4 py-2 text-sm dark:border-zinc-700">Reject</button>
      </div>
    </AppShell>
  )
}
