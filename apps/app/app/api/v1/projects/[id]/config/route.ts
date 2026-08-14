import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { projectMemberships, users } from '@hitly/db/schema'
import { requireApiProject } from '@/lib/api-project'
import { parseProjectConfig, publicOriginFields, saveProjectConfig } from '@/lib/project-config'
import { requireDb } from '@/lib/require-db'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const ctx = await requireApiProject(id)
  if (!ctx.ok) return ctx.error
  if (!ctx.canAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { project } = ctx.access
  const people = await requireDb()
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
    })
    .from(projectMemberships)
    .innerJoin(users, eq(projectMemberships.userId, users.id))
    .where(eq(projectMemberships.projectId, id))

  return NextResponse.json({
    id: project.id,
    name: project.name,
    description: project.description ?? '',
    plugin: project.plugin,
    defaultSlaMinutes: project.defaultSlaMinutes,
    defaultAssigneeUserId: project.defaultAssigneeUserId,
    people,
    ...publicOriginFields(project.plugin, project.credentials),
  })
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const ctx = await requireApiProject(id)
  if (!ctx.ok) return ctx.error
  if (!ctx.canAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseProjectConfig(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const result = await saveProjectConfig(id, parsed)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 404 })
  return NextResponse.json({ ok: true })
}
