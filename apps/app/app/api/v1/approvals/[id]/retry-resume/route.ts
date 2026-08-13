import { NextResponse } from 'next/server'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return NextResponse.json({ id, status: 'retry_queued' })
}
