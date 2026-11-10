import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS } from './config.ts'
import type { HostClient } from './host-client.ts'
import { argsHash } from './jcs.ts'
import { DETAIL_MAX, TOOL_NAMES, toResponseV0, validateDetail, validateQuestion, validateRequestId } from './tools.ts'
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

test('without callback_url: no resumeUrl is sent and HITLy attempts no callback', async () => {
  const { callback_url: _drop, ...noCallback } = baseApproval
  // Even with HITLY_MCP_PUBLIC_URL set (the old no-op-sink config), no
  // resumeUrl may be synthesised and no callback call is attempted.
  const h = await startHarness({ env: { HITLY_MCP_PUBLIC_URL: 'https://mcp.hitly.example' } })
  try {
    const client = await h.client()
    const result = structured(await client.callTool({ name: 'request_approval', arguments: noCallback }))
    assert.equal(result.state, 'pending')
    assert.equal(result.callback, false)
    assert.equal(h.host.ingests.length, 1)
    assert.equal('resumeUrl' in h.host.ingests[0].body, false, 'no resumeUrl is sent at all')
    assert.equal(JSON.stringify(h.host.ingests[0].body).includes('noop'), false, 'no synthesised no-op sink')

    const asked = structured(
      await client.callTool({
        name: 'ask_user',
        arguments: { idempotencyKey: 'bot-ask-nocb', prompt: 'Which day?', answerSchema: { type: 'free_text' } },
      }),
    )
    assert.equal(asked.callback, false)
    assert.equal('resumeUrl' in h.host.ingests[1].body, false)

    // Zero outbound calls beyond the two ingests themselves.
    assert.equal(h.host.ingests.length, 2)
    assert.equal(h.host.reads.length, 0)
    assert.equal(h.host.cancels.length, 0)
    assert.equal(h.host.lists.length, 0)
  } finally {
    await h.close()
  }
  // Without HITLY_MCP_PUBLIC_URL the request is accepted too (it used to be
  // refused): no callback_url simply means no callback.
  const plain = await startHarness()
  try {
    const result = structured(await (await plain.client()).callTool({ name: 'request_approval', arguments: noCallback }))
    assert.equal(result.state, 'pending')
    assert.equal(result.callback, false)
    assert.equal('resumeUrl' in plain.host.ingests[0].body, false)
  } finally {
    await plain.close()
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
    // Aliases are mapped onto the SPEC name before ingest; options are normalised.
    assert.deepEqual(body.answerSchema, {
      type: 'single',
      options: [
        { value: 'Hall A', label: 'Hall A' },
        { value: 'Hall B', label: 'Hall B' },
      ],
    })
    assert.match(String(body.contextMarkdown), /\n\n- Hall A\n- Hall B/)
    assert.match(String(body.contextMarkdown), /\*\*Which venue\?\*\*\n\n- Hall A\n- Hall B$/)

    const missing = await client.callTool({
      name: 'ask_user',
      arguments: { idempotencyKey: 'bot-ask-0002', prompt: 'Which one?', answerSchema: { type: 'multi_choice' }, callback_url: baseApproval.callback_url },
    })
    assert.equal(missing.isError, true)
    assert.match(JSON.stringify(structured(missing)), /multi needs options/)
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

test('ask_user tools/list advertises the spec answer types; no simple_form, no fields', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'ask_user')
    const schema = tool?.inputSchema as Record<string, unknown> | undefined
    assert.ok(schema, 'ask_user must be listed with an input schema')
    const serialized = JSON.stringify(schema)
    assert.doesNotMatch(serialized, /simple_form/, 'simple_form must not be advertised')
    assert.doesNotMatch(serialized, /"fields"/, 'fields[] must not be advertised')
    const answerSchema = (schema as { properties: Record<string, { properties: Record<string, { enum?: string[] }> }> }).properties.answerSchema
    const types = answerSchema.properties.type.enum ?? []
    for (const specName of ['text', 'single', 'multi', 'number']) {
      assert.ok(types.includes(specName), `spec type ${specName} must be advertised`)
    }
    for (const alias of ['free_text', 'single_choice', 'multi_choice']) {
      assert.ok(types.includes(alias), `legacy alias ${alias} stays accepted`)
    }
    assert.ok(!types.includes('simple_form'))
  } finally {
    await h.close()
  }
})

test('ask_user refuses simple_form / fields with the one-request-per-field message', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const form = await client.callTool({
      name: 'ask_user',
      arguments: {
        idempotencyKey: 'bot-ask-form-0001',
        prompt: 'Draft the post?',
        answerSchema: { type: 'simple_form', fields: [{ name: 'headline' }, { name: 'post_date' }, { name: 'notes' }] },
        callback_url: baseApproval.callback_url,
      },
    })
    assert.equal(form.isError, true)
    const formText = JSON.stringify(structured(form))
    assert.match(formText, /invalid_request/)
    assert.match(formText, /one request per field/)
    assert.match(formText, /separate ask_user/)

    const fieldsOnly = await client.callTool({
      name: 'ask_user',
      arguments: {
        idempotencyKey: 'bot-ask-form-0002',
        prompt: 'Draft the post?',
        answerSchema: { type: 'text', fields: [{ name: 'headline' }] },
        callback_url: baseApproval.callback_url,
      },
    })
    assert.equal(fieldsOnly.isError, true)
    assert.match(JSON.stringify(structured(fieldsOnly)), /one request per field/)

    assert.equal(h.host.ingests.length, 0, 'form-shaped asks never reach the host')
  } finally {
    await h.close()
  }
})

test('ask_user maps aliases onto spec types and persists options/bounds; refuses bad combinations', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const seq = { n: 0 }
    const ask = (answerSchema: Record<string, unknown>) =>
      client.callTool({
        name: 'ask_user',
        arguments: {
          idempotencyKey: `bot-ask-map-${String(++seq.n).padStart(4, '0')}`,
          prompt: 'Your answer?',
          answerSchema,
          callback_url: baseApproval.callback_url,
        },
      })

    const freeText = structured(await ask({ type: 'free_text' }))
    assert.equal(freeText.state, 'pending')
    assert.deepEqual(h.host.ingests.at(-1)?.body.answerSchema, { type: 'text' })

    const multi = structured(await ask({ type: 'multi_choice', options: ['a', 'b'] }))
    assert.equal(multi.state, 'pending')
    assert.deepEqual(h.host.ingests.at(-1)?.body.answerSchema, {
      type: 'multi',
      options: [
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b' },
      ],
    })

    const numeric = structured(await ask({ type: 'number', bounds: { min: 0, max: 100, step: 5, unit: '%' } }))
    assert.equal(numeric.state, 'pending')
    assert.deepEqual(h.host.ingests.at(-1)?.body.answerSchema, { type: 'number', bounds: { min: 0, max: 100, step: 5, unit: '%' } })

    const specOptions = structured(await ask({ type: 'single', options: [{ value: 'a', label: 'Alpha', description: 'first' }] }))
    assert.equal(specOptions.state, 'pending')
    assert.deepEqual(h.host.ingests.at(-1)?.body.answerSchema, {
      type: 'single',
      options: [{ value: 'a', label: 'Alpha', description: 'first' }],
    })

    // Refusals (spec 7: never store what the host could not honour).
    assert.match(JSON.stringify(structured(await ask({ type: 'number', bounds: { step: 0 } }))), /step must be greater than 0/)
    assert.match(JSON.stringify(structured(await ask({ type: 'single_choice' }))), /single needs options/)
    assert.match(JSON.stringify(structured(await ask({ type: 'free_text', options: ['a'] }))), /text does not take options/)
    assert.match(JSON.stringify(structured(await ask({ type: 'multi', options: ['a', 'a'] }))), /distinct/)
    assert.equal(
      h.host.ingests.filter((ingest) => String(ingest.body.runId).startsWith('mcp-bot-ask-map-')).length,
      4,
      'only the four accepted asks reached the host',
    )
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

test('toResponseV0 reports callbackDelivery none for no-callback reads and stays silent for delivered ones', () => {
  // Host marks decided requests created without callback_url (no resumeUrl
  // stored, resume skipped) with callbackDelivery: 'none' - never 'failed'.
  const none = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'accept', callbackDelivery: 'none' })
  assert.equal(none.status, 'answered')
  assert.equal(none.value, 'approve')
  assert.equal(none.callbackDelivery, 'none')
  // A decided request that had a working callback: unchanged read, no field.
  assert.equal(toResponseV0({ id: 'apr_1', status: 'decided', decision: 'accept' }).callbackDelivery, undefined)
  // failed_resume still reports failed even if a stale 'none' rode along.
  assert.equal(toResponseV0({ id: 'apr_1', status: 'failed_resume', decision: 'accept', callbackDelivery: 'none' }).callbackDelivery, 'failed')
})

test('get_decision returns the typed ask_user answer exactly as the host stored it [ask_user]', async () => {
  const h = await startHarness({ host: new FakeHost('m0') })
  try {
    const client = await h.client()
    const created = structured(
      await client.callTool({
        name: 'ask_user',
        arguments: {
          idempotencyKey: 'bot-ask-answer-0001',
          prompt: 'Which hall?',
          answerSchema: { type: 'single_choice', options: ['Hall A', 'Hall B'] },
          callback_url: baseApproval.callback_url,
        },
      }),
    )
    const id = created.requestId as string
    const stored = { kind: 'single_choice', value: 'Hall B', note: { confidence: 0.9 } }
    h.host.decide(id, { status: 'decided', decision: 'respond', answer: stored })
    const got = structured(await client.callTool({ name: 'get_decision', arguments: { requestId: id } }))
    assert.equal(got.status, 'answered')
    assert.deepEqual(got.answer, stored, 'the answer must come back verbatim, extra keys included')
    // The reviewer's typed answer must never reach the tool logs.
    assert.equal(h.logs.join('\n').includes('Hall B'), false, 'answer must not leak into logs')
  } finally {
    await h.close()
  }
})

test('toResponseV0 passes the typed answer through and omits it when absent', () => {
  const withAnswer = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'respond', answer: { kind: 'free_text', value: 'Tuesday' } })
  assert.equal(withAnswer.status, 'answered')
  assert.deepEqual(withAnswer.answer, { kind: 'free_text', value: 'Tuesday' })
  const withoutAnswer = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'accept' })
  assert.equal('answer' in withoutAnswer, false, 'no answer, no field')
})

// PM ruling on hitl-spec 4.2 (Test M1): with a typed answer, top-level `answer`
// is the ONLY carrier - `value` MUST NOT appear on the MCP result either, for
// any answered decision kind, and a stored literal null answer counts as absent.
test('toResponseV0 omits value alongside a typed answer (PM ruling)', () => {
  const respond = toResponseV0({
    id: 'apr_1',
    status: 'decided',
    decision: 'respond',
    response: 'Here is the reply text',
    answer: { kind: 'free_text', value: 'Tuesday' },
  })
  assert.equal(respond.status, 'answered')
  assert.equal('value' in respond, false, 'value MUST NOT appear alongside a typed answer')
  assert.deepEqual(respond.answer, { kind: 'free_text', value: 'Tuesday' })

  const accept = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'accept', answer: { kind: 'free_text', value: 'ok' } })
  assert.equal('value' in accept, false, 'accept with a typed answer must not emit value: approve')
  const reject = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'reject', answer: { kind: 'free_text', value: 'no' } })
  assert.equal('value' in reject, false, 'reject with a typed answer must not emit value: reject')

  // A stored literal null answer is absent, so the plain value mapping applies.
  const nullAnswer = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'respond', response: 'Hall B', answer: null })
  assert.equal('answer' in nullAnswer, false, 'stored null answer is treated as absent')
  assert.equal(nullAnswer.value, 'Hall B')

  // No typed answer: value mapping unchanged (regression pins).
  const plainRespond = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'respond', response: 'Hall B' })
  assert.equal(plainRespond.value, 'Hall B')
  const noTextRespond = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'respond' })
  assert.equal('value' in noTextRespond, false, 'respond with no reply text never emits value: ""')
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

test('list_pending accepts cursor, returns nextCursor, and reaches item 101', async () => {
  // Mutant M-mcp: if list_pending ignores input.cursor (always page 1) this goes red.
  const catalog = Array.from({ length: 101 }, (_, i) => ({
    id: `apr_${String(i + 1).padStart(4, '0')}`,
    kind: 'approval',
    question: `Reach item ${i + 1}?`,
    createdAt: '2026-11-09T13:00:00.000Z',
  }))
  const pageSize = 50
  const unused = async () => ({ ok: false as const, status: 501, error: 'unused', code: 'not_supported_by_host' as const })
  const host: HostClient = {
    ingest: unused,
    getApproval: unused,
    cancel: unused,
    listPending: async (_projectId, cursor) => {
      const start = cursor ? catalog.findIndex((item) => item.id === cursor) + 1 : 0
      const from = Math.max(start, 0)
      const page = catalog.slice(from, from + pageSize)
      const last = page[page.length - 1]
      const more = from + page.length < catalog.length
      return { ok: true, status: 200, data: { items: page, nextCursor: more && last ? last.id : null } }
    },
  }
  const h = await startHarness({ deps: { hostFor: () => host } })
  try {
    const client = await h.client()
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'list_pending')
    assert.match(String(listed?.description ?? ''), /nextCursor/)
    assert.match(String(listed?.description ?? ''), /cursor/)

    const first = structured(await client.callTool({ name: 'list_pending', arguments: {} })) as {
      items: Array<{ id: string }>
      nextCursor: string | null
    }
    assert.equal(first.items.length, 50)
    assert.equal(first.nextCursor, 'apr_0050')
    assert.equal(first.items.some((item) => item.id === 'apr_0101'), false)

    const seen: string[] = [...first.items.map((item) => item.id)]
    let cursor: string | null = first.nextCursor
    while (cursor) {
      const page = structured(await client.callTool({ name: 'list_pending', arguments: { cursor } })) as {
        items: Array<{ id: string }>
        nextCursor: string | null
      }
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    }
    assert.equal(seen.length, 101)
    assert.equal(seen[100], 'apr_0101', 'item 101 must be reachable with list_pending cursor')
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

test('deadline: ISO 8601, default 24h, maximum 30 days, past and over-cap refused with a clear tool error', async () => {
  assert.equal(MAX_DEADLINE_MS, 30 * 24 * 60 * 60 * 1000)
  const h = await startHarness()
  try {
    const client = await h.client()
    // Exactly at the cap (30 days) is the last legal value.
    const atCap = structured(
      await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'bot-task-cap30d', deadline: '2026-12-09T13:00:00Z' } }),
    )
    assert.equal(atCap.deadline, '2026-12-09T13:00:00.000Z')
    // One second past the cap is refused with a clear message, before the host call.
    const overCap = await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'bot-task-over30d', deadline: '2026-12-09T13:00:01Z' } })
    assert.equal(overCap.isError, true)
    assert.equal((structured(overCap).error as { code: string }).code, 'invalid_request')
    assert.match(JSON.stringify(structured(overCap)), /30 days/)
    // ask_user shares the same deadline rule.
    const askOver = await client.callTool({
      name: 'ask_user',
      arguments: { idempotencyKey: 'bot-ask-over30d', prompt: 'Pick a slot?', answerSchema: { type: 'free_text' }, callback_url: baseApproval.callback_url, deadline: '2027-01-01T00:00:00Z' },
    })
    assert.equal(askOver.isError, true)
    assert.match(JSON.stringify(structured(askOver)), /30 days/)
    // A past deadline is refused.
    const past = await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'bot-task-past2', deadline: '2026-11-09T12:59:59Z' } })
    assert.equal(past.isError, true)
    assert.match(JSON.stringify(structured(past)), /future/)
    // Only the legal ones reached the host, with the right expiresAt.
    assert.equal(h.host.ingests.length, 1)
    assert.equal(h.host.ingests[0].body.expiresAt, '2026-12-09T13:00:00.000Z')
    // Malformed values never make it past the schema.
    for (const bad of ['tomorrow', '2026-13-01T00:00:00Z', '2026-13-40']) {
      const res = await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'bot-task-bad-deadline', deadline: bad } })
      assert.equal(res.isError, true, bad)
    }
    assert.equal(h.host.ingests.length, 1)
  } finally {
    await h.close()
  }
})

test('requestId is restricted to an id pattern: no ".", ".." or "/" ever reaches the host', async () => {
  assert.equal(validateRequestId('apr_0001'), null)
  assert.notEqual(validateRequestId('..'), null)
  assert.notEqual(validateRequestId('.'), null)
  assert.notEqual(validateRequestId('../../etc/passwd'), null)
  assert.notEqual(validateRequestId('apr/0001'), null)
  assert.notEqual(validateRequestId('apr 0001'), null)
  assert.notEqual(validateRequestId(''), null)
  assert.notEqual(validateRequestId('x'.repeat(65)), null)
  const h = await startHarness({ host: new FakeHost('m0') })
  try {
    const client = await h.client()
    for (const bad of ['..', '.', 'a/../b', 'apr/1', 'apr 1', 'apr%2F1']) {
      const read = await client.callTool({ name: 'get_decision', arguments: { requestId: bad } })
      assert.equal(read.isError, true, bad)
      assert.equal((structured(read).error as { code: string }).code, 'invalid_request', bad)
      const cancelled = await client.callTool({ name: 'cancel', arguments: { requestId: bad } })
      assert.equal(cancelled.isError, true, bad)
      assert.equal((structured(cancelled).error as { code: string }).code, 'invalid_request', bad)
    }
    assert.deepEqual(h.host.reads, [], 'a malformed id must never be sent to the host')
    assert.deepEqual(h.host.cancels, [], 'a malformed id must never be sent to the host')
    // A well-formed id still works.
    const created = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval }))
    assert.equal((structured(await client.callTool({ name: 'get_decision', arguments: { requestId: created.requestId as string } }))).status, 'pending')
  } finally {
    await h.close()
  }
})

test('an edit decision without editedArgs fails closed and is never an approval', () => {
  // Corrupt today-style reads.
  const bare = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'edit' })
  assert.equal(bare.status, 'declined', 'a lost editedArgs is never an approval')
  assert.equal(bare.value, undefined)
  const empty = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'edit', editedArgs: {} })
  assert.equal(empty.status, 'declined')
  assert.equal(empty.value, undefined)
  // The dangerous one: an M0 host read claiming answered/approve for an edit with no args.
  const v0 = toResponseV0({ id: 'apr_1', spec: 'hitl/response/v0', status: 'answered', value: 'approve', decision: 'edit' })
  assert.equal(v0.status, 'declined')
  assert.equal(v0.value, undefined)
  // failed_resume with the same hole also fails closed.
  const failed = toResponseV0({ id: 'apr_1', status: 'failed_resume', decision: 'edit' })
  assert.equal(failed.status, 'declined')
  assert.equal(failed.value, undefined)
  // Positive control: an edit that carries editedArgs is still an approval.
  const ok = toResponseV0({ id: 'apr_1', status: 'decided', decision: 'edit', editedArgs: { amount: 25 } })
  assert.equal(ok.status, 'answered')
  assert.equal(ok.value, 'approve')
  assert.deepEqual(ok.editedArgs, { amount: 25 })
  // accept/reject are unaffected.
  assert.equal(toResponseV0({ id: 'apr_1', status: 'decided', decision: 'accept' }).value, 'approve')
  assert.equal(toResponseV0({ id: 'apr_1', status: 'decided', decision: 'reject' }).value, 'reject')
})

test('the edit fail-closed rule holds over the wire too', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const id = structured(await client.callTool({ name: 'request_approval', arguments: baseApproval })).requestId as string
    h.host.decide(id, { status: 'decided', decision: 'edit' })
    const got = structured(await client.callTool({ name: 'get_decision', arguments: { requestId: id } }))
    assert.equal(got.status, 'declined')
    assert.equal(got.value, undefined)
    assert.equal(JSON.stringify(got).includes('approve'), false)
  } finally {
    await h.close()
  }
})

test('decide-like extras (decision, allowedActions, editedArgs, projectId, plugin, resumeUrl) never reach host ingest', async () => {
  const INGEST_KEYS = new Set([
    'plugin', 'kind', 'runId', 'resumeUrl', 'actionName', 'args', 'question', 'contextMarkdown', 'allowedActions',
    'reasonRequired', 'externalUrls', 'expiresAt', 'argsHash', 'metadata', 'cbAuthToken', 'prompt', 'answerSchema',
  ])
  const host = new FakeHost('m0')
  const h = await startHarness({ host })
  try {
    const client = await h.client()
    // A caller trying to smuggle decision-making fields into the create payloads.
    await client.callTool({
      name: 'request_approval',
      arguments: {
        ...baseApproval,
        idempotencyKey: 'bot-task-smuggle-1',
        decision: 'accept',
        editedArgs: { orderId: 'EVIL' },
        projectId: 'proj_evil',
        plugin: 'evil-plugin',
        resumeUrl: 'https://evil.example/ingest',
        allowedActions: { accept: true, reject: false, ignore: false },
        reason: 'self-approved',
        answer: 'yes',
      },
    })
    await client.callTool({
      name: 'ask_user',
      arguments: {
        idempotencyKey: 'bot-ask-smuggle-1',
        prompt: 'Pick a slot?',
        answerSchema: { type: 'free_text' },
        callback_url: baseApproval.callback_url,
        decision: 'accept',
        editedArgs: { slot: 'EVIL' },
        projectId: 'proj_evil',
        plugin: 'evil-plugin',
        resumeUrl: 'https://evil.example/ingest',
      },
    })
    const id = structured(await client.callTool({ name: 'request_approval', arguments: { ...baseApproval, idempotencyKey: 'bot-task-smuggle-2' } })).requestId as string
    host.decide(id, { status: 'decided', decision: 'edit', editedArgs: { amount: 25 }, reason: 'Partial', decidedBy: { kind: 'human', id: 'u1' } })
    await client.callTool({ name: 'get_decision', arguments: { requestId: id } })
    await client.callTool({ name: 'list_pending', arguments: { projectId: 'proj_evil' } })
    await client.callTool({ name: 'cancel', arguments: { requestId: id, reason: 'done' } })

    assert.equal(host.ingests.length, 3)
    const expectations = [
      { allowedActions: { accept: true, reject: true, ignore: true } },
      { allowedActions: { accept: false, reject: false, respond: true, ignore: true } },
      { allowedActions: { accept: true, reject: true, ignore: true } },
    ]
    for (const [i, { body }] of host.ingests.entries()) {
      for (const key of ['decision', 'editedArgs', 'projectId', 'reason', 'answer', 'value', 'spec'] as const) {
        assert.equal(body[key], undefined, `${key} must never reach ingest (body ${String(i)})`)
      }
      assert.equal(body.plugin, 'http', 'plugin is server-controlled, never caller-supplied')
      assert.equal(body.resumeUrl, baseApproval.callback_url, 'resumeUrl comes from callback_url only')
      assert.deepEqual(body.allowedActions, expectations[i].allowedActions, 'allowedActions is server-controlled')
      for (const key of Object.keys(body)) assert.ok(INGEST_KEYS.has(key), `unexpected ingest field ${key}`)
    }
    // projectId is a query hint for the pending list, not an ingest payload.
    assert.deepEqual(host.lists.map((list) => list.projectId), ['proj_evil'])
    assert.equal(host.ingests.some(({ body }) => JSON.stringify(body).includes('proj_evil')), false)
    assert.equal(host.ingests.some(({ body }) => JSON.stringify(body).includes('EVIL')), false)
  } finally {
    await h.close()
  }
})

test('replay reports the stored deadline, not a freshly computed one (both tools)', async () => {
  const h = await startHarness()
  try {
    const client = await h.client()
    const first = structured(
      await client.callTool({
        name: 'request_approval',
        arguments: { ...baseApproval, deadline: new Date(FIXED_NOW + 2 * 86_400_000).toISOString() },
      }),
    )
    const replay = structured(
      await client.callTool({
        name: 'request_approval',
        arguments: { ...baseApproval, deadline: new Date(FIXED_NOW + 3 * 86_400_000).toISOString() },
      }),
    )
    assert.equal(replay.replayed, true)
    assert.equal(replay.requestId, first.requestId)
    assert.equal(replay.deadline, first.deadline, 'replay must report the deadline stored on create')
    assert.equal(h.host.ingests.length, 2)
    assert.equal(h.host.ingests[1].body.expiresAt, new Date(FIXED_NOW + 3 * 86_400_000).toISOString(), 'only the response is corrected; the host keeps its own idempotent behaviour')

    const askFirst = structured(
      await client.callTool({
        name: 'ask_user',
        arguments: { idempotencyKey: 'bot-ask-replay', prompt: 'Which date?', answerSchema: { type: 'free_text' }, callback_url: baseApproval.callback_url, deadline: new Date(FIXED_NOW + 5 * 86_400_000).toISOString() },
      }),
    )
    const askReplay = structured(
      await client.callTool({
        name: 'ask_user',
        arguments: { idempotencyKey: 'bot-ask-replay', prompt: 'Which date?', answerSchema: { type: 'free_text' }, callback_url: baseApproval.callback_url, deadline: new Date(FIXED_NOW + 10 * 86_400_000).toISOString() },
      }),
    )
    assert.equal(askReplay.replayed, true)
    assert.equal(askReplay.deadline, askFirst.deadline, 'ask_user replay also reports the stored deadline')
  } finally {
    await h.close()
  }
})

test('an oversize JSON-RPC body is refused with 413 before anything is parsed', async () => {
  const h = await startHarness()
  try {
    const huge = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'request_approval', arguments: { ...baseApproval, padding: 'x'.repeat(1.5 * 1024 * 1024) } },
    })
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${'hitly_testkey_AAAAAAAAAAAAAAAAAAAAAAAA'}` },
      body: huge,
    })
    assert.equal(res.status, 413)
    assert.match(await res.text(), /too large/i)
    assert.equal(h.host.ingests.length, 0)
  } finally {
    await h.close()
  }
})
