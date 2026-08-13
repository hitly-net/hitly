import { isPluginId } from '@hitly/core'
import { NextResponse } from 'next/server'
import { getPlugin } from '@/lib/plugins'

export async function POST(request: Request) {
  const apiKey = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 })
  }

  const body = (await request.json()) as Record<string, unknown>
  const pluginId = body.plugin
  if (!isPluginId(pluginId)) {
    return NextResponse.json({ error: 'Unknown plugin' }, { status: 400 })
  }

  try {
    const ingested = getPlugin(pluginId).ingest(body)
    return NextResponse.json({
      id: crypto.randomUUID(),
      status: 'pending',
      envelope: ingested,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ingest failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
