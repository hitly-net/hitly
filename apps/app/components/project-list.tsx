'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { PluginId } from '@hitly/core'
import { PluginMark, pluginBrand } from '@hitly/ui'
import { CreateProjectModal } from '@/components/create-project-modal'

export type ProjectListItem = {
  id: string
  name: string
  description: string | null
  plugin: PluginId
}

export function ProjectList({
  projects,
  canCreate,
}: {
  projects: ProjectListItem[]
  canCreate: boolean
}) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return projects
    return projects.filter((project) => project.name.toLowerCase().includes(term))
  }, [projects, q])

  return (
    <>
      <div className="mt-6 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Filter by name"
          className="h-10 min-w-56 max-w-xl flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        {canCreate ? <CreateProjectModal /> : null}
      </div>
      <ul className="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
        {filtered.length === 0 ? (
          <li className="py-3 text-sm text-zinc-500">
            {projects.length === 0 ? 'No projects yet.' : 'No matching projects.'}
          </li>
        ) : (
          filtered.map((project) => (
            <li key={project.id}>
              <Link
                href={`/projects/${project.id}`}
                className="flex items-center gap-3 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <span
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md"
                  style={{ backgroundColor: pluginBrand(project.plugin).bg }}
                >
                  <PluginMark plugin={project.plugin} className="h-8 w-8" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{project.name}</p>
                  {project.description ? (
                    <p className="truncate text-xs text-zinc-500">{project.description}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-xs text-zinc-500">{pluginBrand(project.plugin).label}</span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </>
  )
}
