/**
 * Push token register/unregister/ownership, Expo send on a new pending item
 * (badge + item id, mock HTTP), ingest when Expo fails, and DeviceNotRegistered
 * ticket/receipt cleanup. Behaviour tests fail if the path is removed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { memberships, pushTokens, users } from '@hitly/db/schema'
import { newId } from './ids'
import {
  closeM0hFixture,
  createM0hFixture,
  ingestHttpAsk,
  type M0hFixture,
} from './m0h-fixture'
import { listPendingPushRecipientIds, notifyPendingItemPush } from './notify'
import { EXPO_PUSH_TIMEOUT_MS, EXPO_PUSH_URL, EXPO_RECEIPTS_URL, isDeviceNotRegistered, sendExpoPush } from './push'
import {
  MAX_PUSH_TOKENS_PER_USER,
  deletePushTokensByValue,
  isExpoPushToken,
  registerPushToken,
  unregisterPushToken,
  listPushTokens,
} from './push-tokens'
import { flushAfterTenantCommitForTests } from './tenant'

if (!process.env.HITLY_ENCRYPTION_KEK) throw new Error('HITLY_ENCRYPTION_KEK required for tests')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for tests')

const dir = path.dirname(fileURLToPath(import.meta.url))
const origFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response
}

function expoToken(label: string) {
  return `ExponentPushToken[${label}]`
}

describe('push tokens', { concurrency: false }, () => {
  let fixture: M0hFixture
  let otherUserId: string

  before(async () => {
    fixture = await createM0hFixture()
    otherUserId = newId('usr').slice(0, 36)
    await fixture.db.insert(users).values({
      id: otherUserId,
      name: 'Other',
      email: `${otherUserId}@push-test.hitly.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  after(async () => {
    if (fixture) {
      await fixture.db.delete(pushTokens).catch(() => undefined)
      await fixture.db.delete(users).where(eq(users.id, otherUserId)).catch(() => undefined)
      await closeM0hFixture(fixture)
    }
    globalThis.fetch = origFetch
  })

  afterEach(async () => {
    await flushAfterTenantCommitForTests()
    globalThis.fetch = origFetch
    if (fixture) await fixture.db.delete(pushTokens)
  })

  it('registers, reassigns ownership, and unregisters only for the current user', async () => {
    const token = expoToken(`own-${newId('t').slice(-8)}`)
    const first = await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
    assert.equal(first.created, true)
    const listed = await listPushTokens(fixture.reviewerId)
    assert.equal(listed.some((row) => row.token === token && row.platform === 'android'), true)

    const moved = await registerPushToken({ userId: otherUserId, token, platform: 'ios' })
    assert.equal(moved.created, false)
    assert.equal(moved.id, first.id)
    assert.equal((await listPushTokens(fixture.reviewerId)).some((row) => row.token === token), false)
    const otherListed = await listPushTokens(otherUserId)
    assert.equal(otherListed.some((row) => row.token === token && row.platform === 'ios'), true)

    await unregisterPushToken({ userId: fixture.reviewerId, token })
    assert.equal((await listPushTokens(otherUserId)).some((row) => row.token === token), true, 'other user must not drop a token they own')

    await unregisterPushToken({ userId: otherUserId, token })
    assert.equal((await listPushTokens(otherUserId)).some((row) => row.token === token), false)
  })

  it('POST/DELETE /api/v1/push-tokens is session-scoped (source)', () => {
    const route = fs.readFileSync(path.join(dir, '../app/api/v1/push-tokens/route.ts'), 'utf8')
    const factory = fs.readFileSync(path.join(dir, 'push-tokens-route.ts'), 'utf8')
    assert.match(route, /requireApiSession/, 'push-tokens route must require a session')
    assert.match(route, /createPushTokensPost/, 'POST must go through the factory that checks the session')
    assert.match(factory, /if \(!ctx\.ok\) return ctx\.error/, 'factory must return 401 when there is no session')
    assert.match(factory, /ctx\.session\.user\.id/, 'register/unregister must use the authenticated user')
    assert.match(factory, /isExpoPushToken/, 'POST must reject non-Expo tokens')
    assert.match(route, /registerPushToken/, 'POST must persist via registerPushToken')
    assert.match(route, /unregisterPushToken/, 'DELETE must persist via unregisterPushToken')
    assert.doesNotMatch(route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /apiKey|projectApiKeys/)
  })

  it('sends on a new pending item with badge = that user pending count and the item id', async () => {
    const token = expoToken(`send-${newId('t').slice(-8)}`)
    await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })

    const captured: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('exp.host')) {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        captured.push({ url, body })
        if (url.startsWith(EXPO_PUSH_URL) || url.includes('/push/send')) {
          return jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] })
        }
        if (url.includes('/push/getReceipts')) {
          return jsonResponse({ data: { 'ticket-1': { status: 'ok' } } })
        }
      }
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    const created = await ingestHttpAsk(fixture, 'https://origin.example', {
      args: { amount: 99, secret: 'do-not-push' },
    })
    await flushAfterTenantCommitForTests()

    const send = captured.find((row) => String(row.url).includes('/push/send'))
    assert.ok(send, 'ingest must POST to the Expo push API')
    const messages = send.body as Array<Record<string, unknown>>
    assert.equal(messages.length, 1)
    assert.equal(messages[0].to, token)
    assert.equal(messages[0].badge, 1)
    const data = messages[0].data as Record<string, string>
    assert.equal(data.itemId, created.id)
    assert.equal(data.approvalId, created.id)
    assert.equal(data.type, 'approval')
    const serialized = JSON.stringify(messages[0])
    assert.equal(serialized.includes('do-not-push'), false, 'push payload must not include request args')
    assert.equal(serialized.includes('"amount"'), false, 'push payload must not include request arguments')
    // PM wording change (branded emails PR): no prompt/summary on this
    // request, so the title is the branded project fallback — never the raw
    // tool name ("refund" must NOT appear).
    assert.equal(messages[0].title, 'HITLy: M0h Project needs your decision')
    assert.equal(String(messages[0].title).includes('refund'), false)
    assert.equal(messages[0].channelId, 'hitly')
    const title = String(messages[0].title ?? '')
    const body = String(messages[0].body ?? '')
    const dataJson = JSON.stringify(messages[0].data ?? {})
    assert.equal(title.includes('do-not-push'), false)
    assert.equal(body.includes('do-not-push'), false)
    assert.equal(dataJson.includes('do-not-push'), false)
  })

  it('item creation still succeeds when Expo push fails', async () => {
    const token = expoToken(`fail-${newId('t').slice(-8)}`)
    await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('exp.host')) {
        return jsonResponse({ error: 'boom' }, 500)
      }
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    const created = await ingestHttpAsk(fixture, 'https://origin.example', { actionName: 'pay' })
    assert.ok(created.id)
    await flushAfterTenantCommitForTests()
    assert.match(created.id, /^apr_/)
  })

  it('item creation does not wait for a slow Expo push', async () => {
    const token = expoToken(`slow-${newId('t').slice(-8)}`)
    await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
    let release: (() => void) | undefined
    const hung = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('exp.host')) {
        await hung
        return jsonResponse({ data: [{ status: 'ok', id: 'ticket-slow' }] })
      }
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    try {
      const started = Date.now()
      const created = await ingestHttpAsk(fixture, 'https://origin.example', { actionName: 'slow-pay' })
      assert.ok(created.id)
      assert.ok(Date.now() - started < 1500, 'ingest must not block on Expo')
    } finally {
      release?.()
      await flushAfterTenantCommitForTests()
    }
  })

  it('DeviceNotRegistered tickets delete the token', async () => {
    const token = expoToken(`ticket-${newId('t').slice(-8)}`)
    await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/push/send')) {
        return jsonResponse({
          data: [{ status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }],
        })
      }
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    await notifyPendingItemPush({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      approvalId: 'apr_ticket_cleanup',
      assignedUserId: fixture.reviewerId,
    })
    assert.equal((await listPushTokens(fixture.reviewerId)).some((row) => row.token === token), false)
  })

  it('DeviceNotRegistered receipts delete the token', async () => {
    const token = expoToken(`receipt-${newId('t').slice(-8)}`)
    await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/push/send')) {
        return jsonResponse({ data: [{ status: 'ok', id: 'ticket-dead' }] })
      }
      if (url.includes('/push/getReceipts')) {
        return jsonResponse({
          data: {
            'ticket-dead': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          },
        })
      }
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    await notifyPendingItemPush({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      approvalId: 'apr_receipt_cleanup',
      assignedUserId: fixture.reviewerId,
    })
    assert.equal((await listPushTokens(fixture.reviewerId)).some((row) => row.token === token), false)
  })

  it('does not notify a workspace member who cannot see the project (M3)', async () => {
    const outsiderToken = expoToken(`out-${newId('t').slice(-8)}`)
    const reviewerToken = expoToken(`in-${newId('t').slice(-8)}`)
    await fixture.db.insert(memberships).values({
      id: newId('mem').slice(0, 36),
      workspaceId: fixture.workspaceId,
      userId: otherUserId,
      role: 'member',
      createdAt: new Date(),
    })
    await registerPushToken({ userId: otherUserId, token: outsiderToken, platform: 'android' })
    await registerPushToken({ userId: fixture.reviewerId, token: reviewerToken, platform: 'android' })
    const sentTo: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/push/send')) {
        const body = JSON.parse(String(init?.body)) as Array<{ to: string }>
        sentTo.push(...body.map((row) => row.to))
        return jsonResponse({ data: body.map(() => ({ status: 'ok', id: 't' })) })
      }
      if (url.includes('/push/getReceipts')) return jsonResponse({ data: {} })
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    const recipients = await listPendingPushRecipientIds({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      assignedUserId: fixture.reviewerId,
    })
    assert.equal(recipients.includes(fixture.reviewerId), true)
    assert.equal(
      recipients.includes(otherUserId),
      false,
      'workspace member without project access must not be a push recipient',
    )

    await notifyPendingItemPush({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      approvalId: 'apr_visibility',
      assignedUserId: fixture.reviewerId,
    })
    assert.equal(sentTo.includes(reviewerToken), true)
    assert.equal(sentTo.includes(outsiderToken), false)
  })

  it('does not delete the token on Expo errors other than DeviceNotRegistered (M4)', async () => {
    const cases = [
      { name: 'MessageRateExceeded', ticket: { status: 'error', details: { error: 'MessageRateExceeded' } } },
      { name: 'InvalidCredentials', ticket: { status: 'error', details: { error: 'InvalidCredentials' } } },
      { name: 'HTTP 500', httpStatus: 500 as const },
    ]
    for (const row of cases) {
      const token = expoToken(`keep-${row.name}-${newId('t').slice(-8)}`)
      await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/push/send')) {
          if ('httpStatus' in row && row.httpStatus) return jsonResponse({ error: 'boom' }, row.httpStatus)
          return jsonResponse({ data: [row.ticket] })
        }
        if (url.includes('/push/getReceipts')) return jsonResponse({ data: {} })
        if (origFetch) return origFetch(input, init)
        throw new Error(`unexpected fetch ${url}`)
      }) as typeof fetch

      await notifyPendingItemPush({
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        approvalId: `apr_keep_${row.name}`,
        assignedUserId: fixture.reviewerId,
      })
      assert.equal(
        (await listPushTokens(fixture.reviewerId)).some((item) => item.token === token),
        true,
        `${row.name} must not delete the token`,
      )
    }
  })

  it('redacted field values never appear in push title, body, or data (M5)', async () => {
    const token = expoToken(`redact-${newId('t').slice(-8)}`)
    await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
    const canaries = ['sk_live_PUSH_REDACT_CANARY', 'tok_live_PUSH_REDACT_CANARY']
    const captured: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/push/send')) {
        const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>
        captured.push(...body)
        return jsonResponse({ data: body.map(() => ({ status: 'ok', id: 't' })) })
      }
      if (url.includes('/push/getReceipts')) return jsonResponse({ data: {} })
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    await ingestHttpAsk(fixture, 'https://origin.example', {
      args: { amount: 99, apiKey: canaries[0], cb_auth_token: canaries[1] },
    })
    await flushAfterTenantCommitForTests()
    assert.ok(captured[0], 'ingest must send a push')
    const title = String(captured[0].title ?? '')
    const body = String(captured[0].body ?? '')
    const data = JSON.stringify(captured[0].data ?? {})
    for (const canary of canaries) {
      assert.equal(title.includes(canary), false, `title must not contain ${canary}`)
      assert.equal(body.includes(canary), false, `body must not contain ${canary}`)
      assert.equal(data.includes(canary), false, `data must not contain ${canary}`)
    }
  })

  it('secret field names never appear in the Android push payload (S1)', async () => {
    const token = expoToken(`names-${newId('t').slice(-8)}`)
    await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
    const secretFieldNames = ['cb_auth_token', 'cbAuthToken', 'authorization', 'authHeader']
    const captured: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/push/send')) {
        const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>
        captured.push(...body)
        return jsonResponse({ data: body.map(() => ({ status: 'ok', id: 't' })) })
      }
      if (url.includes('/push/getReceipts')) return jsonResponse({ data: {} })
      if (origFetch) return origFetch(input, init)
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    await ingestHttpAsk(fixture, 'https://origin.example', {
      args: { amount: 99, cb_auth_token: 'field-set', cbAuthToken: 'field-set' },
      metadata: { pageId: 'p1', cb_auth_token: 'field-set', authorization: 'field-set', authHeader: 'field-set' },
      cb_auth_token: 'field-set',
      cbAuthToken: 'field-set',
    })
    await flushAfterTenantCommitForTests()
    assert.ok(captured[0], 'ingest must send a push')
    const serialized = JSON.stringify(captured[0])
    for (const name of secretFieldNames) {
      assert.equal(serialized.includes(name), false, `push payload must not contain secret field name ${name}`)
    }
    assert.equal(serialized.includes('field-set'), false, 'push payload must not include secret field values')
  })

  it('evicts the oldest token when the user exceeds the cap', async () => {
    const suffix = newId('t').slice(-8)
    const tokens: string[] = []
    const base = Date.now() - 60_000
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_USER; i += 1) {
      const token = expoToken(`cap-${i}-${suffix}`)
      tokens.push(token)
      await registerPushToken({ userId: fixture.reviewerId, token, platform: 'android' })
      await fixture.db
        .update(pushTokens)
        .set({ createdAt: new Date(base + i * 1000) })
        .where(eq(pushTokens.token, token))
    }
    const newest = expoToken(`cap-new-${suffix}`)
    await registerPushToken({ userId: fixture.reviewerId, token: newest, platform: 'android' })
    const listed = await listPushTokens(fixture.reviewerId)
    assert.equal(listed.length, MAX_PUSH_TOKENS_PER_USER)
    assert.equal(listed.some((row) => row.token === tokens[0]), false, 'oldest token must be evicted')
    assert.equal(listed.some((row) => row.token === newest), true)
    assert.equal(listed.some((row) => row.token === tokens[tokens.length - 1]), true)
  })
})

describe('isExpoPushToken', () => {
  it('accepts Expo shapes and rejects anything else', () => {
    assert.equal(isExpoPushToken('ExponentPushToken[abc]'), true)
    assert.equal(isExpoPushToken('ExpoPushToken[abc]'), true)
    assert.equal(isExpoPushToken('gcm-deadbeef'), false)
    assert.equal(isExpoPushToken('ExponentPushToken[]'), false)
    assert.equal(isExpoPushToken('ExponentPushToken'), false)
    assert.equal(isExpoPushToken(''), false)
  })
})

describe('sendExpoPush DeviceNotRegistered (no DB)', () => {
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('marks ticket DeviceNotRegistered tokens stale', async () => {
    let sendInit: RequestInit | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === EXPO_PUSH_URL || url.includes('/push/send')) {
        sendInit = init
        return jsonResponse({
          data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const result = await sendExpoPush({
      tokens: ['ExponentPushToken[dead]'],
      title: 't',
      body: 'b',
      data: { itemId: 'apr_1' },
    })
    assert.deepEqual(result.staleTokens, ['ExponentPushToken[dead]'])
    assert.equal(isDeviceNotRegistered({ details: { error: 'DeviceNotRegistered' } }), true)
    assert.ok(sendInit?.signal instanceof AbortSignal, 'Expo send must pass AbortSignal.timeout')
  })

  it('marks receipt DeviceNotRegistered tokens stale', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/push/send')) {
        return jsonResponse({ data: [{ status: 'ok', id: 'tid' }] })
      }
      if (url === EXPO_RECEIPTS_URL || url.includes('/push/getReceipts')) {
        return jsonResponse({
          data: { tid: { status: 'error', details: { error: 'DeviceNotRegistered' } } },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    const result = await sendExpoPush({
      tokens: ['ExponentPushToken[dead]'],
      title: 't',
      body: 'b',
      data: { itemId: 'apr_1' },
    })
    assert.deepEqual(result.staleTokens, ['ExponentPushToken[dead]'])
  })
})

describe('push source canaries', () => {
  it('ingest fire-and-forgets Expo via afterTenantCommit; DeviceNotRegistered deletes tokens', () => {
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const notifySrc = strip(fs.readFileSync(path.join(dir, 'notify.ts'), 'utf8'))
    const approvalsSrc = strip(fs.readFileSync(path.join(dir, 'approvals.ts'), 'utf8'))
    const pushSrc = strip(fs.readFileSync(path.join(dir, 'push.ts'), 'utf8'))
    const ingestFn = approvalsSrc.split('export async function ingestApproval')[1]?.split('export async function decideApproval')[0] ?? ''
    assert.match(notifySrc, /afterTenantCommit/, 'push must be scheduled outside the tenant transaction')
    assert.match(ingestFn, /notifyAssignee\(/, 'new pending items must notify')
    assert.doesNotMatch(ingestFn, /await sendExpoPush/, 'ingest must not await Expo HTTP')
    assert.match(pushSrc, /extractDecisionEmailContent/, 'push copy must reuse the branded-email wording helper')
    assert.match(pushSrc, /title: content\.pushTitle/, 'push title must come from the shared decision copy helper')
    assert.doesNotMatch(pushSrc, /actionName/, 'push copy must not read raw tool names')
    assert.doesNotMatch(pushSrc, /`Hitly:/, 'push copy must not use Hitly')
    assert.match(pushSrc, /DeviceNotRegistered/, 'tickets/receipts must handle DeviceNotRegistered')
    assert.match(pushSrc, /EXPO_RECEIPTS_URL|getReceipts/, 'receipts must be checked')
    assert.match(pushSrc, /AbortSignal\.timeout/, 'Expo send must time out')
    assert.match(String(EXPO_PUSH_TIMEOUT_MS), /^10000$/)
    const tokensSrc = strip(fs.readFileSync(path.join(dir, 'push-tokens.ts'), 'utf8'))
    assert.match(tokensSrc, /deletePushTokensByValue/, 'stale tokens must be deletable')
    assert.match(tokensSrc, /MAX_PUSH_TOKENS_PER_USER/, 'per-user cap must exist')
    assert.equal(MAX_PUSH_TOKENS_PER_USER, 20)
    void deletePushTokensByValue
  })
})
