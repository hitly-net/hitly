import type { ProjectStatus } from '@hitly/core'
import { Badge } from '@hitly/ui'

export function ProjectStatusBadge({ status }: { status: ProjectStatus | string }) {
  if (status === 'live' || !status) return null
  return (
    <Badge variant={status === 'paused' ? 'warning' : 'secondary'} className="capitalize">
      {status}
    </Badge>
  )
}

export function ProjectHeading({ name, status }: { name: string; status: ProjectStatus | string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-2xl font-semibold">{name}</h1>
      <ProjectStatusBadge status={status} />
    </div>
  )
}

export function ProjectStatusBanner({ status }: { status: ProjectStatus | string }) {
  if (status === 'paused') {
    return (
      <div className="mt-4 max-w-xl rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        This project is paused. New requests are refused; pending items can still be decided.
      </div>
    )
  }
  if (status === 'archived') {
    return (
      <div className="mt-4 max-w-xl rounded-md border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
        This project is archived. It is hidden from the inbox and lists, and is read-only until a workspace admin
        unarchives it.
      </div>
    )
  }
  return null
}
