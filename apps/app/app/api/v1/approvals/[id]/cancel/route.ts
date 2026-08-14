import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { approvals } from '@hitly/db/schema'
import { auth } from '@/lib/auth'
import { cancelApproval } from '@/lib/approvals'
import { canDecide, getProjectAccess } from '@/lib/rbac'
import { getMembership } from '@/lib/context'
import { requireDb } from '@/lib/require-db'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!auth) return NextResponse.json({ error: 'Database not configured' }, { status: 503 })
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await context.params
  const database = requireDb()
  const rows = await database.select().from(approvals).where(eq(approvals.id, id)).limit(1)
  const approval = rows[0]
  if (!approval) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const membership = await getMembership(approval.workspaceId, session.user.id)
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const access = await getProjectAccess({
    projectId: approval.projectId,
    userId: session.user.id,
    workspaceRole: membership.role,
  })
  if (!canDecide(access)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const result = await cancelApproval({ approvalId: id, actorUserId: session.user.id })
  if ('error' in result && result.error) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json({ id, status: result.status, decision: 'cancel' })
}
