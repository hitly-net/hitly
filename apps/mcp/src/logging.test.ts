import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientIdFor, createLogger } from './logger.ts'
import { FakeHost, startHarness, TEST_KEY } from './test-helpers.ts'

const SENTINELS = {
  question: 'Pay SENTINEL_QUESTION now?',
  context: 'SENTINEL_CONTEXT details',
  arg: 'SENTINEL_ARG_VALUE',
  callback: 'https://SENTINEL-CALLBACK.example/cb',
  token: 'SENTINEL_TOKEN_abcdefghijklmnop',
  prompt: 'SENTINEL_PROMPT?',
  detail: 'SENTINEL_DETAIL markdown ## heading',
  option: 'SENTINEL_OPTION',
  reason: 'SENTINEL_REASON',
  response: 'SENTINEL_RESPONSE',
  edited: 'SENTINEL_EDITED',
}

test('logs carry only ids, status, latency and client id - never payload, key or token', async () => {
  const host = new FakeHost('m0')
  const h = await startHarness({ host, env: { HITLY_HOST_CAPABILITIES: 'cb_auth_token' } })
  try {
    const client = await h.client()
    const created = await client.callTool({
      name: 'request_approval',
      arguments: {
        idempotencyKey: 'bot-task-log-0001',
        question: SENTINELS.question,
        context: SENTINELS.context,
        action: { name: 'pay', args: { to: SENTINELS.arg } },
        callback_url: SENTINELS.callback,
        cb_auth_token: SENTINELS.token,
        links: [{ url: 'https://sentinel-link.example/SENTINEL_LINK' }],
      },
    })
    const id = (created.structuredContent as { requestId: string }).requestId
    await client.callTool({
      name: 'ask_user',
      arguments: {
        idempotencyKey: 'bot-ask-log-0001',
        prompt: SENTINELS.prompt,
        detail: SENTINELS.detail,
        answerSchema: { type: 'single_choice', options: [SENTINELS.option] },
        callback_url: SENTINELS.callback,
      },
    })
    // Over-cap detail: the refusal message itself must not leak the detail into logs either.
    await client.callTool({
      name: 'ask_user',
      arguments: {
        idempotencyKey: 'bot-ask-log-0002',
        prompt: SENTINELS.prompt,
        detail: `${SENTINELS.detail} ${'x'.repeat(8_001)}`,
        answerSchema: { type: 'free_text' },
        callback_url: SENTINELS.callback,
      },
    })
    host.decide(id, { status: 'decided', decision: 'edit', response: SENTINELS.response, reason: SENTINELS.reason, editedArgs: { to: SENTINELS.edited } })
    await client.callTool({ name: 'get_decision', arguments: { requestId: id } })
    await client.callTool({ name: 'list_pending', arguments: {} })
    await client.callTool({ name: 'cancel', arguments: { requestId: id, reason: SENTINELS.reason } })
    // Failing calls too: validation errors and host errors must not leak into logs.
    await client.callTool({ name: 'request_approval', arguments: { idempotencyKey: 'bot-task-log-0002', question: 'SENTINEL_BAD.', action: { name: 'x', args: {} }, callback_url: SENTINELS.callback } })
    await client.callTool({ name: 'get_decision', arguments: { requestId: 'SENTINEL ID WITH SPACES' } })
    await fetch(`${h.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer SENTINEL_BADKEY' }, body: '{}' })

    const all = h.logs.join('\n')
    assert.ok(h.logs.length >= 8)
    for (const value of Object.values(SENTINELS)) assert.equal(all.includes(value), false, value)
    assert.doesNotMatch(all, /SENTINEL/)
    assert.equal(all.includes(TEST_KEY), false)
    assert.ok(all.includes(clientIdFor(TEST_KEY)))
    assert.ok(all.includes(id))

    const allowed = new Set(['ts', 'event', 'tool', 'requestId', 'status', 'latencyMs', 'clientId', 'port'])
    for (const line of h.logs) {
      const entry = JSON.parse(line) as Record<string, unknown>
      for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `unexpected log field ${key}`)
    }
    const tools = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === 'tool')
    assert.deepEqual(
      tools.map((entry) => entry.tool),
      ['request_approval', 'ask_user', 'ask_user', 'get_decision', 'list_pending', 'cancel', 'request_approval', 'get_decision'],
    )
  } finally {
    await h.close()
  }
})

test('logger drops non-allowlisted fields and non-id values at runtime', () => {
  const lines: string[] = []
  const logger = createLogger((line) => lines.push(line))
  logger.log({ event: 'tool', requestId: 'has spaces and SECRET', status: 'free text SECRET', ...({ question: 'SECRET?' } as object) })
  assert.doesNotMatch(lines[0], /SECRET/)
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['event', 'ts'])
  assert.doesNotMatch(clientIdFor(TEST_KEY), /hitly_/)
})
