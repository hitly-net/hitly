import { NextResponse } from 'next/server'
import { registerDefaultHousekeepingJobs } from '@/lib/housekeeping/jobs'
import { listHousekeepingJobs, runDueHousekeeping } from '@/lib/housekeeping/scheduler'

function authorize(request: Request) {
  const secret = process.env.HITLY_CRON_SECRET
  const header = request.headers.get('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null
  if (secret) return token === secret
  return process.env.NODE_ENV !== 'production'
}

export async function POST(request: Request) {
  if (!authorize(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { job?: string; force?: boolean } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text) as { job?: string; force?: boolean }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  registerDefaultHousekeepingJobs()
  try {
    const runs = await runDueHousekeeping({
      job: typeof body.job === 'string' ? body.job : undefined,
      force: body.force === true,
    })
    return NextResponse.json({ ok: true, jobs: listHousekeepingJobs(), runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Housekeeping failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
