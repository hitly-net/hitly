import Link from 'next/link'
import { DECISIONS } from '@hitly/core'
import { AppShell } from '@/components/app-shell'
import { getAppContext } from '@/lib/context'
import { AUDIT_SORTS, listAudit, type AuditSort } from '@/lib/inbox'

export const metadata = { title: 'Audit' }

const COLUMNS: { key: AuditSort; label: string }[] = [
  { key: 'createdAt', label: 'Time' },
  { key: 'decision', label: 'Decision' },
  { key: 'actionName', label: 'Action' },
  { key: 'projectName', label: 'Project' },
  { key: 'actorName', label: 'Actor' },
]

function auditHref(values: {
  q?: string
  projectId?: string
  decision?: string
  sort?: string
  dir?: string
}) {
  const params = new URLSearchParams()
  if (values.q) params.set('q', values.q)
  if (values.projectId) params.set('projectId', values.projectId)
  if (values.decision) params.set('decision', values.decision)
  const sort = values.sort || 'createdAt'
  const dir = values.dir === 'asc' ? 'asc' : 'desc'
  if (sort !== 'createdAt' || dir !== 'desc') {
    params.set('sort', sort)
    params.set('dir', dir)
  }
  const qs = params.toString()
  return qs ? `/audit?${qs}` : '/audit'
}

function timeLabel(createdAt: Date) {
  return createdAt.toISOString().slice(0, 19).replace('T', ' ')
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    projectId?: string
    decision?: string
    sort?: string
    dir?: string
  }>
}) {
  const query = await searchParams
  const q = query.q?.trim() ?? ''
  const projectId = query.projectId?.trim() ?? ''
  const decision = query.decision?.trim() ?? ''
  const sort: AuditSort = AUDIT_SORTS.includes(query.sort as AuditSort) ? (query.sort as AuditSort) : 'createdAt'
  const dir = query.dir === 'asc' ? 'asc' : 'desc'
  const { workspace, user, role } = await getAppContext()
  const rows = await listAudit({
    workspaceId: workspace.id,
    userId: user.id,
    workspaceRole: role,
    q: q || undefined,
    projectId: projectId || undefined,
    decision: decision || undefined,
    sort,
    dir,
  })
  const filtered = Boolean(q || projectId || decision)
  const formFiltered = Boolean(q || decision)

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Audit</h1>
      <p className="mt-2 text-sm text-zinc-500">
        {projectId
          ? 'Decision records for the selected project.'
          : 'Decision records across projects in this workspace.'}
      </p>
      <form method="get" action="/audit" className="mt-6 flex max-w-4xl flex-wrap gap-2">
        {sort !== 'createdAt' || dir !== 'desc' ? (
          <>
            <input type="hidden" name="sort" value={sort} />
            <input type="hidden" name="dir" value={dir} />
          </>
        ) : null}
        {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
        <input
          name="q"
          defaultValue={q}
          placeholder="Search action, project, or actor"
          className="h-10 min-w-56 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <select
          name="decision"
          defaultValue={decision}
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All decisions</option>
          {DECISIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="h-10 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Filter
        </button>
        {formFiltered ? (
          <Link href={auditHref({ projectId, sort, dir })} className="inline-flex h-10 items-center text-sm underline">
            Clear
          </Link>
        ) : null}
      </form>
      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">{filtered ? 'No matching decisions.' : 'No decisions yet.'}</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
                {COLUMNS.map((column) => {
                  const active = sort === column.key
                  const nextDir = active && dir === 'desc' ? 'asc' : 'desc'
                  return (
                    <th key={column.key} className="py-2 pr-4 font-medium">
                      <Link
                        href={auditHref({ q, projectId, decision, sort: column.key, dir: nextDir })}
                        className={active ? 'text-zinc-900 dark:text-zinc-100' : 'hover:text-zinc-900'}
                      >
                        {column.label}
                        {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </Link>
                    </th>
                  )
                })}
                <th className="py-2 font-medium">Resume</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-zinc-200 dark:border-zinc-800">
                  <td className="whitespace-nowrap py-3 pr-4 text-xs text-zinc-500">{timeLabel(row.createdAt)}</td>
                  <td className="py-3 pr-4 capitalize">{row.decision}</td>
                  <td className="py-3 pr-4">
                    <Link href={`/projects/${row.projectId}/item/${row.approvalId}`} className="underline">
                      {row.actionName}
                    </Link>
                  </td>
                  <td className="py-3 pr-4">
                    <Link href={`/projects/${row.projectId}`} className="text-zinc-600 underline dark:text-zinc-400">
                      {row.projectName}
                    </Link>
                  </td>
                  <td className="py-3 pr-4">
                    <span>{row.actorName ?? 'Unknown'}</span>
                    {row.actorEmail ? <span className="block text-xs text-zinc-500">{row.actorEmail}</span> : null}
                  </td>
                  <td className="py-3">
                    {row.resumeError ? (
                      <span className="text-amber-700 dark:text-amber-400">Failed</span>
                    ) : (
                      <span className="text-zinc-500">Ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  )
}
