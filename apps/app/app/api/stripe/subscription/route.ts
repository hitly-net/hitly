import { NextResponse } from 'next/server'
import { isWorkspaceAdmin } from '@hitly/core'
import { GET as cloudGet, POST as cloudPost } from '@hitly/cloud/stripe/subscription'
import { requireApiWorkspace } from '@/lib/api-session'
import { getWorkspaceRecord } from '@/lib/context'

async function billingContext() {
  const result = await requireApiWorkspace()
  if (!result.ok) return result
  if (!result.workspace || !result.role) {
    return { ok: false as const, error: NextResponse.json({ error: 'No workspace' }, { status: 400 }) }
  }
  if (!isWorkspaceAdmin(result.role)) {
    return { ok: false as const, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  const record = await getWorkspaceRecord(result.workspace.id)
  return {
    ok: true as const,
    ctx: {
      workspaceId: result.workspace.id,
      stripeCustomerId: record?.stripeCustomerId ?? null,
      stripeSubscriptionId: record?.stripeSubscriptionId ?? null,
    },
  }
}

export async function GET(request: Request) {
  const result = await billingContext()
  if (!result.ok) return result.error
  return cloudGet(request, result.ctx)
}

export async function POST(request: Request) {
  const result = await billingContext()
  if (!result.ok) return result.error
  return cloudPost(request, result.ctx)
}
