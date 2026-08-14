import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { projectChannels } from '@hitly/db/schema'
import { toggleProjectChannel } from '@/actions/projects'
import { AppShell } from '@/components/app-shell'
import { ProjectTabs } from '@/components/project-tabs'
import { canAdminProject } from '@/lib/rbac'
import { requireVisibleProject } from '@/lib/project-page'
import { requireDb } from '@/lib/require-db'

export const metadata = { title: 'Channels' }

export default async function ProjectChannelsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { project, access } = await requireVisibleProject(id)
  if (!canAdminProject(access)) redirect(`/projects/${id}`)
  const channels = await requireDb().select().from(projectChannels).where(eq(projectChannels.projectId, id))

  return (
    <AppShell project={{ id: project.id, name: project.name }}>
      <h1 className="text-2xl font-semibold">{project.name}</h1>
      <ProjectTabs projectId={id} current="Channels" />
      <p className="mt-4 text-sm text-zinc-500">
        How assignees learn there is a work item. Decisions stay in the inbox. Slack and Telegram adapters come later.
      </p>
      <ul className="mt-6 max-w-xl divide-y divide-zinc-200 dark:divide-zinc-800">
        {channels.map((channel) => (
          <li key={channel.id} className="flex items-center justify-between py-3 text-sm">
            <div>
              <p className="font-medium capitalize">{channel.type}</p>
              <p className="text-xs text-zinc-500">{channel.enabled ? 'Enabled' : 'Disabled'}</p>
            </div>
            <form action={toggleProjectChannel.bind(null, id, channel.id, !channel.enabled)}>
              <button type="submit" className="text-xs underline">
                {channel.enabled ? 'Disable' : 'Enable'}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </AppShell>
  )
}
