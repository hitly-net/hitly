import { NextResponse } from 'next/server'
import { requireApiProject } from '@/lib/api-project'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const ctx = await requireApiProject(id)
  if (!ctx.ok) return ctx.error
  const { project } = ctx.access
  return NextResponse.json({
    id: project.id,
    name: project.name,
    description: project.description,
    plugin: project.plugin,
    canAdmin: ctx.canAdmin,
  })
}
