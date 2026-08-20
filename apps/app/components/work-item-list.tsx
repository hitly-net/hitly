import Link from 'next/link'
import type { ReactNode } from 'react'
import type { PluginId, Decision } from '@hitly/core'
import { Badge, PluginMark } from '@hitly/ui'
import { formatStatusLabel } from '@/lib/status-label'

function ageLabel(createdAt: Date) {
  return createdAt.toISOString().slice(0, 16).replace('T', ' ')
}

export type WorkItemRow = {
  id: string
  status: string
  actionName: string
  plugin: string
  projectId: string
  projectName: string
  createdAt: Date
  decision?: Decision | string | null
}

export function WorkItemList({
  items,
  empty,
  hrefFor,
  showProjectName = false,
}: {
  items: WorkItemRow[]
  empty: ReactNode
  hrefFor: (item: WorkItemRow) => string
  showProjectName?: boolean
}) {
  if (items.length === 0) return empty
  return (
    <ul className="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
      {items.map((item) => (
        <li key={item.id}>
          <Link href={hrefFor(item)} className="flex items-center gap-3 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900">
            <PluginMark plugin={item.plugin as PluginId} className="h-8 w-8" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{item.actionName}</p>
              {showProjectName ? <p className="text-xs text-zinc-500">{item.projectName}</p> : null}
            </div>
            <span className="text-xs text-zinc-500">{ageLabel(item.createdAt)}</span>
            <Badge
              variant={
                item.status === 'pending' || item.status === 'failed_resume'
                  ? 'warning'
                  : item.status === 'decided'
                    ? 'success'
                    : 'secondary'
              }
            >
              {formatStatusLabel(item.status, item.decision)}
            </Badge>
          </Link>
        </li>
      ))}
    </ul>
  )
}
