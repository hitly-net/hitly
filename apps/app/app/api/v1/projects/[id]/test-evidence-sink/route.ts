import { NextResponse } from 'next/server'
import { requireApiProject } from '@/lib/api-project'
import { withApiTenant } from '@/lib/api-session'
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

    const pingPayload = {
      spec: 'hitly.evidence.v1',
      event_type: 'ping',
      test: true,
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-hitly-ping': 'true',
    }

    if (authHeader) {
      headers.authorization = authHeader
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(pingPayload),
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const snippet = text.slice(0, 200)
        return NextResponse.json({
          ok: false,
          status: response.status,
          message: `Evidence sink returned ${response.status}: ${snippet}`,
        })
      }

      return NextResponse.json({
        ok: true,
        status: response.status,
        message: 'Evidence sink is reachable',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error'
      return NextResponse.json({
        ok: false,
        status: 0,
        message: `Failed to reach evidence sink: ${message}`,
      })
    }
  })
}
