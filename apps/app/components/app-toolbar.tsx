'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { switchWorkspace } from '@/actions/workspace'
import { SignOutButton } from '@/components/sign-out-button'
import {
  toolbarBackHref,
  toolbarPage,
  toolbarProjectHref,
  toolbarProjectIdFromPath,
  toolbarWorkspaceHref,
} from '@/lib/toolbar'

const selectClass =
  'h-8 min-w-40 max-w-64 rounded-md border border-zinc-200 bg-transparent px-2 text-sm dark:border-zinc-700'

export function AppToolbar({
  workspaces,
  currentWorkspaceId,
  projects,
  activeProjectId,
  userName,
}: {
  workspaces: { id: string; name: string }[]
  currentWorkspaceId: string
  projects: { id: string; name: string }[]
  activeProjectId?: string | null
  userName: string
}) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const backHref = toolbarBackHref(pathname)
  const page = toolbarPage(pathname)
  const selectedProject =
    toolbarProjectIdFromPath(pathname) ?? searchParams.get('projectId') ?? activeProjectId ?? ''

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-6 dark:border-zinc-800 dark:bg-zinc-950">
      {backHref ? (
        <Link
          href={backHref}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </Link>
      ) : null}
      <select
        className={selectClass}
        value={currentWorkspaceId}
        aria-label="Workspace"
        onChange={(event) => {
          void switchWorkspace(event.target.value, toolbarWorkspaceHref(pathname))
        }}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
      <select
        className={selectClass}
        value={selectedProject}
        aria-label="Project"
        onChange={(event) => {
          const href = toolbarProjectHref(pathname, searchParams.toString(), event.target.value || null)
          if (href !== `${pathname}${searchParams.toString() ? `?${searchParams}` : ''}`) {
            router.push(href)
          }
        }}
      >
        {page === 'project-item' ? null : <option value="">All projects</option>}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <div className="ml-auto flex items-center gap-3 text-sm">
        <Link href="/settings/profile">{userName}</Link>
        <SignOutButton />
      </div>
    </header>
  )
}
