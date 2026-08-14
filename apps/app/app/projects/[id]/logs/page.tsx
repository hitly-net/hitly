import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import { projectEvents } from '@hitly/db/schema'
import { AppShell } from '@/components/app-shell'
import { JsonDisclosure } from '@/components/json-disclosure'
import { ProjectTabs } from '@/components/project-tabs'
import { asOriginRef, originSummary } from '@/lib/origin'
import { requireVisibleProject } from '@/lib/project-page'
import { requireDb } from '@/lib/require-db'

export const metadata = { title: 'Logs' }

export default async function ProjectLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { project } = await requireVisibleProject(id)
  const events = await requireDb()
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.projectId, id))
    .orderBy(desc(projectEvents.createdAt))
    .limit(200)

  return (
    <AppShell project={{ id: project.id, name: project.name }}>
      <h1 className="text-2xl font-semibold">{project.name}</h1>
      <ProjectTabs projectId={id} current="Logs" />
      <ul className="mt-6 max-w-3xl divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        {events.length === 0 ? (
          <li className="text-zinc-500">No events yet. Ingest an approval to see logs.</li>
        ) : (
          events.map((event) => {
            const origin = asOriginRef(event.payload.origin)
            const summary = origin ? originSummary(origin) : null
            return (
            <li key={event.id} className="py-3">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span className="uppercase">{event.level}</span>
                <span>{event.type}</span>
                <span>{event.createdAt.toISOString()}</span>
                {event.approvalId ? (
                  <Link href={`/projects/${id}/item/${event.approvalId}`} className="underline">
                    item {event.approvalId.slice(0, 12)}…
                  </Link>
                ) : null}
              </div>
              <p className="mt-1">{event.message}</p>
              {summary ? <p className="mt-1 text-xs text-zinc-500">{summary}</p> : null}
              {Object.keys(event.payload ?? {}).length > 0 ? (
                <JsonDisclosure
                  className="mt-2 rounded-md border border-zinc-200 dark:border-zinc-800"
                  value={event.payload}
                />
              ) : null}
            </li>
            )
          })
        )}
      </ul>
    </AppShell>
  )
}
