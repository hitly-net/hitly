import { NextResponse } from 'next/server'
import { isWorkspaceAdmin } from '@hitly/core'
import { POST as cloudCheckout } from '@hitly/cloud/stripe/checkout'
import { requireApiWorkspace } from '@/lib/api-session'
import { getWorkspaceRecord } from '@/lib/context'

export async function POST(request: Request) {
  const result = await requireApiWorkspace()
  if (!result.ok) return result.error
  if (!result.workspace || !result.role) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }
  if (!isWorkspaceAdmin(result.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const record = await getWorkspaceRecord(result.workspace.id)
  return cloudCheckout(request, {
    workspaceId: result.workspace.id,
    stripeCustomerId: record?.stripeCustomerId ?? null,
    stripeSubscriptionId: record?.stripeSubscriptionId ?? null,
  })
}
