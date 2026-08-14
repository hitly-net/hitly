'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  INBOX_SCOPES,
  isDefaultListFilters,
  listFiltersHref,
  parseListFilters,
  readListFilters,
  writeListFilters,
  type InboxScope,
} from '@/lib/list-filters'

const SCOPE_LABELS: Record<InboxScope, string> = {
  all: 'All',
  open: 'Pending',
  closed: 'Decided',
}

export function WorkItemFilters({
  storageKey,
  basePath,
  scope,
  q,
  projectId,
}: {
  storageKey: string
  basePath: string
  scope: InboxScope
  q: string
  projectId?: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const current = parseListFilters({ scope, q, projectId })
    if (searchParams.toString()) {
      writeListFilters(storageKey, current)
      return
    }
    const stored = readListFilters(storageKey)
    if (!stored || isDefaultListFilters(stored)) return
    router.replace(listFiltersHref(basePath, stored))
  }, [basePath, projectId, q, router, scope, searchParams, storageKey])

  const current = parseListFilters({ scope, q, projectId })

  return (
    <>
      <nav className="mt-6 flex gap-4 border-b border-zinc-200 text-sm dark:border-zinc-800">
        {INBOX_SCOPES.map((value) => {
          const active = scope === value
          return (
            <Link
              key={value}
              href={listFiltersHref(basePath, { ...current, scope: value })}
              className={
                active
                  ? 'border-b-2 border-zinc-900 pb-2 font-medium dark:border-zinc-100'
                  : 'pb-2 text-zinc-500 hover:text-zinc-900'
              }
            >
              {SCOPE_LABELS[value]}
            </Link>
          )
        })}
      </nav>
      <form method="get" action={basePath} className="mt-4 flex max-w-xl flex-wrap gap-2">
        <input type="hidden" name="scope" value={scope} />
        {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
        <input
          name="q"
          defaultValue={q}
          placeholder="Filter by topic"
          className="h-10 min-w-56 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          className="h-10 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Filter
        </button>
        {q ? (
          <Link
            href={listFiltersHref(basePath, { ...current, q: '' })}
            className="inline-flex h-10 items-center text-sm underline"
          >
            Clear
          </Link>
        ) : null}
      </form>
    </>
  )
}
