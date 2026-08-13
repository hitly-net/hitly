import { NextResponse } from 'next/server'
import { isDecision } from '@hitly/core'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const body = (await request.json()) as Record<string, unknown>
  if (!isDecision(body.decision)) {
    return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
  }
  return NextResponse.json({
    id,
    status: 'decided',
    decision: body.decision,
  })
}
