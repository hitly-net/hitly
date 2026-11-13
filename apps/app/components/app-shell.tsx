import { Suspense, type ReactNode } from 'react'
import { edition } from '@hitly/cloud'
import { getAppContext } from '@/lib/context'
import { listVisibleProjects } from '@/lib/rbac'
import { can } from '@/lib/tier-entitlements'
import { requireVerifiedEmailGateEnabled, shouldShowUnverifiedEmailBanner } from '@/lib/verified-gate'
import { AppSidebar } from './app-sidebar'
import { AppToolbar } from './app-toolbar'
import { UnverifiedEmailBanner } from './unverified-email-banner'

export async function AppShell({
  children,
  project,
}: {
  children: ReactNode
  project?: { id: string; name: string } | null
}) {
  const { user, workspaces, workspace, role } = await getAppContext()
  // Nav gating reads the tier entitlements map (single helper; no plan
  // comparisons here or in the edition).
  const nav: typeof edition.navItems = []
  for (const item of edition.navItems) {
    if (!item.feature || (await can(workspace, item.feature))) nav.push(item)
  }
  const projects = await listVisibleProjects({
    workspaceId: workspace.id,
    userId: user.id,
    workspaceRole: role,
  })
  // GA gate banner: only when the flag is on and this address is unverified.
  const showVerifyBanner = shouldShowUnverifiedEmailBanner({
    flagEnabled: requireVerifiedEmailGateEnabled(),
    emailVerified: user.emailVerified,
  })

  return (
    <div className="flex h-dvh overflow-hidden">
      <AppSidebar nav={nav} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-14 shrink-0 border-b border-zinc-200 dark:border-zinc-800" />}>
          <AppToolbar
            workspaces={workspaces}
            currentWorkspaceId={workspace.id}
            projects={projects}
            activeProjectId={project?.id}
            userName={user.name}
            userEmail={user.email}
          />
        </Suspense>
        {showVerifyBanner ? <UnverifiedEmailBanner /> : null}
        <main className="min-h-0 flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
