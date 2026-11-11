/**
 * M2: POST /api/v1/push-tokens without a session is 401. Removing the
 * requireApiSession check (or registering before it) must go red.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { NextResponse } from 'next/server'
import { createPushTokensPost } from './push-tokens-route'

const dir = path.dirname(fileURLToPath(import.meta.url))

function postRequest(body: unknown) {
  return new Request('http://localhost/api/v1/push-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('push-tokens route (M2 session)', () => {
  it('wires requireApiSession in the Next route module', () => {
    const route = fs.readFileSync(path.join(dir, '../app/api/v1/push-tokens/route.ts'), 'utf8')
    const factory = fs.readFileSync(path.join(dir, 'push-tokens-route.ts'), 'utf8')
    assert.match(route, /requireApiSession/, 'route must pass requireApiSession')
    assert.match(route, /createPushTokensPost/, 'route must use the POST factory')
    const postFn = factory.split('return async function POST')[1]?.split('return async function DELETE')[0] ?? factory
    const guard = postFn.search(/if \(!ctx\.ok\) return ctx\.error/)
    const persist = postFn.search(/persist\(|registerPushToken/)
    assert.ok(guard >= 0, 'POST must return ctx.error when the session is missing')
    assert.ok(persist > guard, 'register must not run before the session guard')
  })

  it('POST with no session returns 401 and does not register (removing the guard must fail)', async () => {
    let registered = 0
    const POST = createPushTokensPost({
      requireApiSession: async () => ({
        ok: false as const,
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      }),
      registerPushToken: async () => {
        registered += 1
        throw new Error('registerPushToken must not run without a session')
      },
    })
    const response = await POST(
      postRequest({ token: 'ExponentPushToken[no-session]', platform: 'android' }),
    )
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Unauthorized' })
    assert.equal(registered, 0, 'token must not be persisted without a session')
  })

  it('POST rejects a non-Expo token with 400', async () => {
    let registered = 0
    const POST = createPushTokensPost({
      requireApiSession: async () => ({
        ok: true as const,
        session: { user: { id: 'usr_1', name: 'R', email: 'r@example.com' } },
      }),
      registerPushToken: async () => {
        registered += 1
        return { id: 'ptk_x', created: true as const }
      },
    })
    const response = await POST(postRequest({ token: 'gcm-not-expo', platform: 'android' }))
    assert.equal(response.status, 400)
    assert.equal(registered, 0)
  })

  it('POST accepts ExponentPushToken and ExpoPushToken', async () => {
    const seen: string[] = []
    const POST = createPushTokensPost({
      requireApiSession: async () => ({
        ok: true as const,
        session: { user: { id: 'usr_1', name: 'R', email: 'r@example.com' } },
      }),
      registerPushToken: async (args) => {
        seen.push(args.token)
        return { id: 'ptk_x', created: true as const }
      },
    })
    const exponent = await POST(postRequest({ token: 'ExponentPushToken[ok1]', platform: 'android' }))
    const expo = await POST(postRequest({ token: 'ExpoPushToken[ok2]', platform: 'ios' }))
    assert.equal(exponent.status, 200)
    assert.equal(expo.status, 200)
    assert.deepEqual(seen, ['ExponentPushToken[ok1]', 'ExpoPushToken[ok2]'])
  })
})
