import { NextResponse } from 'next/server'
import type { requireApiSession } from './api-session'
import { isExpoPushToken, isPushPlatform, registerPushToken, unregisterPushToken } from './push-tokens'

type RequireApiSession = typeof requireApiSession

function readToken(body: unknown) {
  if (!body || typeof body !== 'object') return ''
  const token = (body as { token?: unknown }).token
  return typeof token === 'string' ? token.trim() : ''
}

export function createPushTokensPost(deps: {
  requireApiSession: RequireApiSession
  registerPushToken?: typeof registerPushToken
}) {
  const persist = deps.registerPushToken ?? registerPushToken
  return async function POST(request: Request) {
    const ctx = await deps.requireApiSession()
    if (!ctx.ok) return ctx.error
    const body = (await request.json().catch(() => ({}))) as { token?: unknown; platform?: unknown }
    const token = readToken(body)
    if (!isExpoPushToken(token)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }
    if (!isPushPlatform(body.platform)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }
    const result = await persist({
      userId: ctx.session.user.id,
      token,
      platform: body.platform,
    })
    return NextResponse.json({ id: result.id, created: result.created })
  }
}

export function createPushTokensDelete(deps: {
  requireApiSession: RequireApiSession
  unregisterPushToken?: typeof unregisterPushToken
}) {
  const persist = deps.unregisterPushToken ?? unregisterPushToken
  return async function DELETE(request: Request) {
    const ctx = await deps.requireApiSession()
    if (!ctx.ok) return ctx.error
    const body = await request.json().catch(() => ({}))
    const token = readToken(body)
    if (!token) return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    await persist({ userId: ctx.session.user.id, token })
    return NextResponse.json({ ok: true })
  }
}
