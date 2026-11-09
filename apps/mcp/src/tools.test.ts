import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_DEADLINE_MS } from './config.ts'
import { argsHash } from './jcs.ts'
import { DETAIL_MAX, TOOL_NAMES, toResponseV0, validateDetail, validateQuestion } from './tools.ts'
import { baseApproval, FakeHost, FIXED_NOW, startHarness, structured } from './test-helpers.ts'

test('exactly the five requester tools are listed; there is no decide tool', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [...TOOL_NAMES].sort())
    for (const name of names) assert.doesNotMatch(name, /decide|approve|answer|respond|reject/i)
    for (const name of ['decide', 'approve', 'decide_request', 'answer']) {
      const result = await client.callTool({ name, arguments: { requestId: 'apr_0001', decision: 'accept' } }).catch((error: Error) => error)
      if (result instanceof Error) assert.match(result.message, /not found|Unknown tool/i)
      else assert.equal(result.isError, true)
    }
    const get = tools.find((tool) => tool.name === 'get_decision')
    assert.equal(get?.annotations?.readOnlyHint, true)
  } finally {
    await h.close()
  }
})

test('request_approval maps to HTTP ingest with callback_url as resumeUrl and returns pending at once', async () => {
  const h = await startHarness({ env: { HITLY_APP_URL: 'https://app.hitly.example' } })
  try {
    const client = await h.client()
    const result = structured(
      await client.callTool({
        name: 'request_approval',
        arguments: {
          ...baseApproval,
          context: 'Customer asked twice.',
          risk: 'medium',
          reasonRequired: ['reject', 'approve'],
          links: [{ url: 'https://shop.example/orders/1234', label: 'Order', mustOpen: true }],
        },
      }),
    )
    assert.equal(result.state, 'pending')
    assert.equal(result.replayed, false)
    assert.equal(result.requestId, 'apr_0001')
    assert.equal(result.argsHash, argsHash({ orderId: '1234', amount: 40 }))
    assert.equal(result.reviewUrl, 'https://app.hitly.example/inbox/apr_0001')
    assert.equal(result.callback, true)

    assert.equal(h.host.ingests.length, 1)
    const { body, idempotencyKey } = h.host.ingests[0]
    assert.equal(idempotencyKey, 'bot-task-0001')
    assert.equal(body.plugin, 'http')
    assert.equal(body.kind, 'approval')
    assert.equal(body.resumeUrl, 'https://bot.example/hitly/callback')
    assert.equal(body.runId, 'mcp-bot-task-0001')
    assert.equal(body.actionName, 'refund')
    assert.deepEqual(body.args, { orderId: '1234', amount: 40 })
    assert.deepEqual(body.allowedActions, { accept: true, reject: true, ignore: true })
    assert.deepEqual(body.reasonRequired, ['reject', 'accept'])
    assert.deepEqual(body.externalUrls, [{ url: 'https://shop.example/orders/1234', label: 'Order', mustOpen: true }])
    assert.match(String(body.contextMarkdown), /^\*\*Send the refund.*\?\*\*\n\nCustomer asked twice\.$/)
    assert.deepEqual(body.metadata, { source: 'hitly-mcp', risk: 'medium' })
    assert.equal(body.cbAuthToken, undefined)
  } finally {
    await h.close()
  }
})

test('default deadline is 24h from now; an explicit deadline is kept; past deadlines are refused', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const first = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval }))
    const expected = new Date(FIXED_NOW + 24 * 60 * 60 * 1000).toISOString()
    assert.equal(DEFAULT_DEADLINE_MS, 86_400_000)
    assert.equal(first.deadline, expected)
    assert.equal(h.host.ingests[0].body.expiresAt, expected)

    const asked = structured(
      await client.callTool({
        name: 'ask_user',
        arguments: { idempotencyKey: 'bot-ask-0001', prompt: 'Which day works?', answerSchema: { type: 'free_text' }, callback_url: baseApproval.callback_url },
      }),
    )
    assert.equal(asked.deadline, expected)

    const explicit = structured(
      await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'bot-task-0002', deadline: '2026-11-09T15:00:00+00:00' } }),
    )
    assert.equal(explicit.deadline, '2026-11-09T15:00:00.000Z')

    const past = await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'bot-task-0003', deadline: '2026-11-09T12:00:00Z' } })
    assert.equal(past.isError, true)
    assert.match(JSON.stringify(structured(past)), /future/)
  } finally {
    await h.close()
  }
})

test('request_approval validates the question and https-only callback and links', async () => {
  assert.equal(validateQuestion('Ship it?'), null)
  assert.match(String(validateQuestion('Ship it.')), /end with/)
  assert.match(String(validateQuestion(`${'x'.repeat(160)}?`)), /160/)
  assert.match(String(validateQuestion('Line one\nline two?')), /one sentence/)
  const h = await startHarness()
  try {
    const client = await h.client()
    const bad = await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, question: 'Ship it.' } })
    assert.equal(bad.isError, true)
    const http = await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, callback_url: 'http://bot.example/cb' } })
    assert.equal(http.isError, true)
    const link = await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, links: [{ url: 'http://x.example' }] } })
    assert.equal(link.isError, true)
    assert.equal(h.host.ingests.length, 0)
  } finally {
    await h.close()
  }
})

test('without callback_url: refused unless HITLY_MCP_PUBLIC_URL provides the no-op sink', async () => {
  const { callback_url: _drop, ...noCallback } = baseApproval
  const strict = await startHarness()
  try {
    const result = await (await strict.client()).callTool({ name: 'request_approval', arguments: noCallback })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(structured(result)), /callback_url is required/)
  } finally {
    await strict.close()
  }
  const sink = await startHarness({ env: { HITLY_MCP_PUBLIC_URL: 'https://mcp.hitly.example' } })
  try {
    const result = structured(await (await sink.client()).callTool({ name: 'request_approval', arguments: noCallback }))
    assert.equal(result.callback, false)
    assert.equal(sink.host.ingests[0].body.resumeUrl, 'https://mcp.hitly.example/callbacks/noop')
  } finally {
    await sink.close()
  }
})

test('cb_auth_token is refused until the host supports it, then forwarded and never echoed [M0h]', async () => {
  const token = 'cbtok_SECRET_1234567890abcdef'
  const today = await startHarness()
  try {
    const result = await (await today.client()).callTool({ name: 'request_approval', arguments: { ...baseApproval, cb_auth_token: token } })
    assert.equal(result.isError, true)
    assert.equal((structured(result).error as { code: string }).code, 'not_supported_by_host')
    assert.equal(today.host.ingests.length, 0)
  } finally {
    await today.close()
  }
  const m0h = await startHarness({ env: { HITLY_HOST_CAPABILITIES: 'cb_auth_token' } })
  try {
    const result = await (await m0h.client()).callTool({ name: 'request_approval', arguments: { ...baseApproval, cb_auth_token: token } })
    assert.equal(result.isError, undefined)
    assert.equal(m0h.host.ingests[0].body.cbAuthToken, token)
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
  } finally {
    await m0h.close()
  }
})

test('create-once: same idempotencyKey replays the same request, including after a server restart', async () => {
  const host = new FakeHost()
  const first = await startHarness({ host })
  let id: unknown
  try {
    const client = await first.client()
    id = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval })).requestId
    const again = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval }))
    assert.equal(again.requestId, id)
    assert.equal(again.replayed, true)
  } finally {
    await first.close()
  }
  const restarted = await startHarness({ host })
  try {
    const replay = structured(await (await restarted.client()).callTool({ name: 'request_approval', arguments: baseApproval }))
    assert.equal(replay.requestId, id)
    assert.equal(replay.replayed, true)
    assert.equal(host.rows.size, 1)
  } finally {
    await restarted.close()
  }
})

test('ask_user maps to HTTP ingest as a question with a free-text answer', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const result = structured(
      await client.callTool({
        name: 'ask_user',
        arguments: {
          idempotencyKey: 'bot-ask-0001',
          prompt: 'Which venue?',
          answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
          callback_url: baseApproval.callback_url,
        },
      }),
    )
    assert.equal(result.state, 'pending')
    const { body } = h.host.ingests[0]
    assert.equal(body.kind, 'question')
    assert.equal(body.resumeUrl, baseApproval.callback_url)
    assert.deepEqual(body.allowedActions, { accept: false, reject: false, respond: true, ignore: true })
    assert.deepEqual(body.answerSchema, { type: 'single_choice', options: ['Hall A', 'Hall B'] })
    assert.match(String(body.contextMarkdown), /\n\n- Hall A\n- Hall B/)
    assert.match(String(body.contextMarkdown), /\*\*Which venue\?\*\*\n\n- Hall A\n- Hall B$/)

    const missing = await client.callTool({
      name: 'ask_user',
      arguments: { idempotencyKey: 'bot-ask-0002', prompt: 'Which one?', answerSchema: { type: 'multi_choice' }, callback_url: baseApproval.callback_url },
    })
    assert.equal(missing.isError, true)
  } finally {
    await h.close()
  }
})

test('ask_user keeps the headline rule: one line, max 160 chars, ends with "?"', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    let seq = 0
    const ask = (prompt: string, extra: Record<string, unknown> = {}) =>
      client.callTool({
        name: 'ask_user',
        arguments: {
          idempotencyKey: `bot-ask-headline-${String(++seq).padStart(4, '0')}`,
          prompt,
          answerSchema: { type: 'free_text' },
          callback_url: baseApproval.callback_url,
          ...extra,
        },
      })
    assert.equal((await ask('Which venue?')).isError, undefined)
    assert.match(JSON.stringify(structured(await ask('Which venue.'))), /end with/)
    assert.match(JSON.stringify(structured(await ask(`${'x'.repeat(160)}?`))), /160/)
    assert.match(JSON.stringify(structured(await ask('Line one\nline two?'))), /one sentence/)
    assert.match(JSON.stringify(structured(await ask('   '))), /required/)
    assert.equal(h.host.ingests.length, 1, 'only the accepted ask reached the host')
  } finally {
    await h.close()
  }
})

test('ask_user accepts optional markdown detail, passes it through under the headline, refuses over the cap', async () => {
  assert.equal(DETAIL_MAX, 8_000)
  assert.equal(validateDetail('## Why\nBecause.'), null)
  assert.equal(validateDetail('x'.repeat(DETAIL_MAX)), null)
  assert.match(String(validateDetail('x'.repeat(DETAIL_MAX + 1))), /at most 8000 characters/)
  assert.match(String(validateDetail('   ')), /blank/)
  const h = await startHarness()
  try {
    const client = await h.client()
    const detail = '## Why I ask\nThe venue **matters** because:\n\n- capacity\n- parking'
    const result = structured(
      await client.callTool({
        name: 'ask_user',
        arguments: {
          idempotencyKey: 'bot-ask-detail-0001',
          prompt: 'Which venue?',
          detail,
          answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
          context: 'Contract note.',
          callback_url: baseApproval.callback_url,
        },
      }),
    )
    assert.equal(result.state, 'pending')
    const { body } = h.host.ingests[0]
    assert.equal(body.contextMarkdown, `**Which venue?**\n\n${detail}\n\n- Hall A\n- Hall B\n\nContract note.`)

    const atCap = await client.callTool({
      name: 'ask_user',
      arguments: { idempotencyKey: 'bot-ask-detail-cap', prompt: 'Which venue?', detail: 'x'.repeat(DETAIL_MAX), answerSchema: { type: 'free_text' }, callback_url: baseApproval.callback_url },
    })
    assert.equal(atCap.isError, undefined)

    const overCap = await client.callTool({
      name: 'ask_user',
      arguments: { idempotencyKey: 'bot-ask-detail-over', prompt: 'Which venue?', detail: 'x'.repeat(DETAIL_MAX + 1), answerSchema: { type: 'free_text' }, callback_url: baseApproval.callback_url },
    })
    assert.equal(overCap.isError, true)
    assert.match(JSON.stringify(structured(overCap)), /detail must be at most 8000 characters/)
    assert.match(JSON.stringify(structured(overCap)), /invalid_request/)
    assert.equal(h.host.ingests.length, 2, 'over-cap detail never reaches the host')
  } finally {
    await h.close()
  }
})

test('get_decision: pending, approve, reject, declined, expired, cancelled (today\u2019s key read)', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const id = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval })).requestId as string
    const pending = structured(await client.callTool({ name: 'get_decision', arguments: { requestId: id } }))
    assert.deepEqual(pending, { spec: 'hitl/response/v0', requestId: id, status: 'pending', activity: { presentedAt: null, items: [] } })

    h.host.decide(id, { status: 'decided', decision: 'accept', presentedAt: '2026-11-09T13:01:00.000Z' })
    const approved = structured(await client.callTool({ name: 'get_decision', arguments: { requestId: id } }))
    assert.equal(approved.status, 'answered')
    assert.equal(approved.value, 'approve')
    assert.equal(approved.editedArgs, undefined)
    assert.deepEqual(approved.activity, { presentedAt: '2026-11-09T13:01:00.000Z', items: [] })

    for (const [read, status, value] of [
      [{ status: 'decided', decision: 'reject' }, 'answered', 'reject'],
      [{ status: 'decided', decision: 'ignore' }, 'declined', undefined],
      [{ status: 'expired', decision: undefined }, 'expired', undefined],
      [{ status: 'cancelled', decision: 'cancel' }, 'cancelled', undefined],
      [{ status: 'decided', decision: 'respond', response: 'Hall B' }, 'answered', 'Hall B'],
    ] as const) {
      h.host.decide(id, read)
      const got = structured(await client.callTool({ name: 'get_decision', arguments: { requestId: id } }))
      assert.equal(got.status, status)
      assert.equal(got.value, value)
    }
    const missing = await client.callTool({ name: 'get_decision', arguments: { requestId: 'apr_nope' } })
    assert.equal((structured(missing).error as { code: string }).code, 'not_found')
  } finally {
    await h.close()
  }
})

test('get_decision returns editedArgs and v0 fields when the host provides them [M0]', async () => {
  const h = await startHarness({ host: new FakeHost('m0') })
  try {
    const client = await h.client()
    const created = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval }))
    const id = created.requestId as string
    h.host.decide(id, {
      spec: 'hitl/response/v0',
      status: 'answered',
      value: 'approve',
      decision: 'edit',
      editedArgs: { amount: 25 },
      reason: 'Partial refund',
      decidedBy: { kind: 'human', id: 'user_1' },
      decidedAt: '2026-11-09T13:05:00.000Z',
      argsHash: created.argsHash,
      activity: { presentedAt: '2026-11-09T13:01:00.000Z', items: [] },
    })
    const got = structured(await client.callTool({ name: 'get_decision', arguments: { requestId: id } }))
    assert.equal(got.status, 'answered')
    assert.equal(got.value, 'approve')
    assert.deepEqual(got.editedArgs, { amount: 25 })
    // The stored request is immutable: argsHash still covers the original args.
    assert.equal(got.argsHash, argsHash(baseApproval.action.args))
    assert.equal(got.reason, 'Partial refund')
    assert.deepEqual(got.decidedBy, { kind: 'human', id: 'user_1' })
    assert.deepEqual(h.host.ingests[0].body.args, baseApproval.action.args)
  } finally {
    await h.close()
  }
})

test('toResponseV0 omits empty editedArgs and flags failed callback delivery', () => {
  const out = toResponseV0({ id: 'apr_1', status: 'failed_resume', decision: 'accept', editedArgs: {} })
  assert.equal(out.status, 'answered')
  assert.equal(out.value, 'approve')
  assert.equal(out.editedArgs, undefined)
  assert.equal(out.callbackDelivery, 'failed')
  assert.deepEqual(toResponseV0({ id: 'apr_1', status: 'decided', decision: 'edit', editedArgs: { a: 1 } }).editedArgs, { a: 1 })
})

test('list_pending reports not_supported_by_host on today\u2019s host', async () => {
  const h = await startHarness()
  try {
    const result = await (await h.client()).callTool({ name: 'list_pending', arguments: {} })
    assert.equal(result.isError, true)
    assert.equal((structured(result).error as { code: string }).code, 'not_supported_by_host')
  } finally {
    await h.close()
  }
})

test('list_pending returns this key\u2019s open requests [M0]', async () => {
  const h = await startHarness({ host: new FakeHost('m0') })
  try {
    const client = await h.client()
    await client.callTool({ name: 'request_approval', arguments: baseApproval })
    await client.callTool({
      name: 'ask_user',
      arguments: { idempotencyKey: 'bot-ask-0001', prompt: 'Which day?', answerSchema: { type: 'free_text' }, callback_url: baseApproval.callback_url },
    })
    const other = await h.client('hitly_otherkey_BBBBBBBBBBBBBBBBBBBBBBBB')
    await other.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'other-0001' } })
    const { items } = structured(await client.callTool({ name: 'list_pending', arguments: {} })) as { items: Record<string, unknown>[] }
    assert.equal(items.length, 2)
    assert.deepEqual(items.map((item) => item.kind), ['approval', 'question'])
    assert.equal(items[0].question, baseApproval.question)
    assert.equal(items[1].prompt, 'Which day?')
  } finally {
    await h.close()
  }
})

test('cancel explains that requester cancel is not available on today\u2019s host', async () => {
  const h = await startHarness()
  try {
    const result = await (await h.client()).callTool({ name: 'cancel', arguments: { requestId: 'apr_0001' } })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(structured(result)), /requester cancel/)
  } finally {
    await h.close()
  }
})

test('cancel withdraws the request and get_decision then reports cancelled [M0]', async () => {
  const h = await startHarness({ host: new FakeHost('m0') })
  try {
    const client = await h.client()
    const id = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval })).requestId as string
    const cancelled = structured(await client.callTool({ name: 'cancel', arguments: { requestId: id, reason: 'no longer needed' } }))
    assert.deepEqual(cancelled, { requestId: id, state: 'cancelled' })
    const got = structured(await client.callTool({ name: 'get_decision', arguments: { requestId: id } }))
    assert.equal(got.status, 'cancelled')
    assert.equal(got.value, undefined)
  } finally {
    await h.close()
  }
})
