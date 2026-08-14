import { NextResponse } from 'next/server'
import { inArray, asc } from 'drizzle-orm'
import { projects } from '@hitly/db/schema'
import { requireApiWorkspace } from '@/lib/api-session'
import { canAdminProject, getProjectAccess, listVisibleProjectIds } from '@/lib/rbac'
import { requireDb } from '@/lib/require-db'

export async function GET() {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) return NextResponse.json({ projects: [] })

  const ids = await listVisibleProjectIds({
    workspaceId: ctx.workspace.id,
    userId: ctx.session.user.id,
    workspaceRole: ctx.role,
  })
  if (ids.length === 0) return NextResponse.json({ projects: [] })

  const list = await requireDb()
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      plugin: projects.plugin,
    })
    .from(projects)
    .where(inArray(projects.id, ids))
    .orderBy(asc(projects.name))

  const detailed = await Promise.all(
    list.map(async (project) => {
      const access = await getProjectAccess({
        projectId: project.id,
        userId: ctx.session.user.id,
        workspaceRole: ctx.role!,
      })
      return { ...project, canAdmin: canAdminProject(access) }
    }),
  )

  return NextResponse.json({ projects: detailed })
}
