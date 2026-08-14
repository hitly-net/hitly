import { NextResponse } from 'next/server'
import { isDevicePlatform, registerUserDevice, unregisterUserDevice } from '@/lib/devices'
import { requireApiSession } from '@/lib/api-session'

function readToken(body: unknown) {
  if (!body || typeof body !== 'object') return ''
  const token = (body as { token?: unknown }).token
  return typeof token === 'string' ? token.trim() : ''
}

export async function POST(request: Request) {
  const ctx = await requireApiSession()
  if (!ctx.ok) return ctx.error
  const body = (await request.json().catch(() => ({}))) as { token?: unknown; platform?: unknown }
  const token = readToken(body)
  if (!token || token.length > 255) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
  }
  if (!isDevicePlatform(body.platform)) {
    return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
  }
  const result = await registerUserDevice({
    userId: ctx.session.user.id,
    token,
    platform: body.platform,
  })
  return NextResponse.json({ id: result.id, created: result.created })
}

export async function DELETE(request: Request) {
  const ctx = await requireApiSession()
  if (!ctx.ok) return ctx.error
  const body = await request.json().catch(() => ({}))
  const token = readToken(body)
  if (!token) return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
  await unregisterUserDevice({ userId: ctx.session.user.id, token })
  return NextResponse.json({ ok: true })
}
