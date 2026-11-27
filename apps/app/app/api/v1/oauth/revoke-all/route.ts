import { NextResponse } from 'next/server'
import { isWorkspaceAdmin } from '@hitly/core'
import { handleRevokeAll } from '@hitly/cloud/mcp-oauth/routes'
import { requireApiWorkspace } from '@/lib/api-session'

/** Workspace admin cuts off every marketplace agent granted on this workspace. */
export async function POST(request: Request) {
  const result = await requireApiWorkspace()
  if (!result.ok) return result.error
  if (!result.workspace || !result.role) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }
  if (!isWorkspaceAdmin(result.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown }
  if (body.workspaceId && body.workspaceId !== result.workspace.id) {
    return NextResponse.json({ error: 'Workspace mismatch' }, { status: 403 })
  }
  const { revoked } = await handleRevokeAll(result.workspace.id)
  return NextResponse.json({ ok: true, revoked })
}
