import { NextResponse } from 'next/server'
import { getWorkspaceRecord } from '@/lib/context'
import { requireApiWorkspace } from '@/lib/api-session'
import { parseWorkspaceSettings, saveWorkspaceSettings } from '@/lib/workspace-settings'
import { canManageWorkspace } from '@/lib/rbac'

export async function GET() {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const record = await getWorkspaceRecord(ctx.workspace.id)
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    id: record.id,
    name: record.name,
    slug: record.slug,
    timezone: record.timezone,
    defaultSlaMinutes: record.defaultSlaMinutes,
    plan: record.plan,
    role: ctx.role,
    canManage: canManageWorkspace(ctx.role),
  })
}

export async function PATCH(request: Request) {
  const ctx = await requireApiWorkspace()
  if (!ctx.ok) return ctx.error
  if (!ctx.workspace || !ctx.role) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!canManageWorkspace(ctx.role)) {
    return NextResponse.json({ error: 'Only workspace admins can update workspace settings' }, { status: 403 })
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = parseWorkspaceSettings(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  await saveWorkspaceSettings(ctx.workspace.id, parsed)
  const record = await getWorkspaceRecord(ctx.workspace.id)
  return NextResponse.json({
    id: ctx.workspace.id,
    name: parsed.name,
    slug: record?.slug ?? ctx.workspace.slug,
    timezone: parsed.timezone,
    defaultSlaMinutes: parsed.sla,
    plan: record?.plan ?? ctx.workspace.plan,
    role: ctx.role,
    canManage: true,
  })
}
