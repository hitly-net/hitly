import { NextResponse } from 'next/server'
import { requireApiProject } from '@/lib/api-project'
import { withApiTenant } from '@/lib/api-session'
import { pingEvidenceSink } from '@/lib/evidence-sink'
import { decodeTenantJson } from '@/lib/tenant-crypto'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return withApiTenant(async () => {
    const ctx = await requireApiProject(id)
    if (!ctx.ok) return ctx.error
    if (!ctx.canAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { project } = ctx.access

    if (project.evidenceSinkType !== 'http') {
      return NextResponse.json({ error: 'Evidence sink is not configured' }, { status: 400 })
    }

    const sinkConfig = project.evidenceSinkConfig
      ? await decodeTenantJson(project.workspaceId, project.evidenceSinkConfig as Record<string, unknown>)
      : {}

    const url = typeof sinkConfig.url === 'string' ? sinkConfig.url : ''
    if (!url) {
      return NextResponse.json({ error: 'Evidence sink URL is not configured' }, { status: 400 })
    }

    const authHeader = typeof sinkConfig.authHeader === 'string' ? sinkConfig.authHeader : undefined
    return NextResponse.json(await pingEvidenceSink(url, authHeader))
  })
}
