import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeHost, startHarness, TEST_KEY, baseApproval } from './test-helpers.ts'

/**
 * Grok Bot is a stateless MCP client: it keeps no session affinity, never
 * resumes a server-initiated SSE stream, and may issue every call as a fresh
 * initialize from a different connection. This harness talks raw JSON-RPC to
 * prove the server works for exactly that shape of client — no SDK client
 * convenience, and no `Mcp-Session-Id` ever sent or required. Spec-wise the
 * client advertises `Accept: application/json, text/event-stream` (the MCP
 * Streamable HTTP minimum), but every response here must come back as plain
 * JSON: this server never streams.
 */

const PROTOCOL_VERSION = '2025-06-18'

type Rpc = { jsonrpc: '2.0'; id: number; result?: Record<string, unknown>; error?: { code: number; message: string } }

let rpcId = 0

async function postRpc(
  url: string,
  key: string | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ res: Response; rpc: Rpc | null }> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await res.text()
  if (res.ok) {
    assert.match(String(res.headers.get('content-type')), /application\/json/, 'stateless server must answer in JSON, never SSE')
  }
  return { res, rpc: text ? (JSON.parse(text) as Rpc) : null }
}

/** Grok-style call: brand-new initialize immediately before the tool call. */
async function grokCallTool(url: string, name: string, args: Record<string, unknown>, key = TEST_KEY) {
  const init = await postRpc(url, key, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'grok-bot-sim', version: '0' },
  })
  assert.equal(init.res.status, 200)
  const call = await postRpc(url, key, 'tools/call', { name, arguments: args })
  assert.equal(call.res.status, 200, `tools/call ${name} failed: ${call.rpc?.error?.message}`)
  assert.equal(call.rpc?.error, undefined, `tools/call ${name}: ${call.rpc?.error?.message}`)
  return call.rpc?.result as {
    isError?: boolean
    structuredContent?: Record<string, unknown>
  }
}

const toolStruct = (result: { isError?: boolean; structuredContent?: Record<string, unknown> }) => {
  assert.notEqual(result.isError, true)
  assert.ok(result.structuredContent, 'structuredContent missing')
  return result.structuredContent
}

test('grok client: tools/list works statelessly and advertises the five requester tools', async () => {
  const h = await startHarness()
  try {
    const listed = await postRpc(h.url, TEST_KEY, 'tools/list')
    assert.equal(listed.res.status, 200)
    const tools = (listed.rpc?.result as { tools: { name: string }[] }).tools
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['ask_user', 'cancel', 'get_decision', 'list_pending', 'request_approval'],
    )
    // No session was ever minted: Grok-style clients never carry one.
    assert.equal(listed.res.headers.get('mcp-session-id'), null)
  } finally {
    await h.close()
  }
})

test('grok client: request_approval returns pending at once, get_decision gates the action', async () => {
  const host = new FakeHost()
  const h = await startHarness({ host })
  try {
    const created = toolStruct(await grokCallTool(h.url, 'request_approval', { ...baseApproval }))
    assert.equal(created.state, 'pending')
    const requestId = created.requestId as string
    assert.ok(requestId)

    // Pending is not approval: before the human decides, the poll must say pending.
    const before = toolStruct(await grokCallTool(h.url, 'get_decision', { requestId }))
    assert.equal(before.status, 'pending')
    assert.equal(before.value, undefined)

    host.decide(requestId, { status: 'decided', decision: 'accept' })
    const after = toolStruct(await grokCallTool(h.url, 'get_decision', { requestId }))
    assert.equal(after.status, 'answered')
    assert.equal(after.value, 'approve')
  } finally {
    await h.close()
  }
})

test('grok client: reviewer edit comes back as editedArgs to act on', async () => {
  const host = new FakeHost()
  const h = await startHarness({ host })
  try {
    const created = toolStruct(await grokCallTool(h.url, 'request_approval', { ...baseApproval }))
    const requestId = created.requestId as string
    const editedArgs = { orderId: '1234', amount: 25 }
    host.decide(requestId, { status: 'decided', decision: 'edit', editedArgs })
    const after = toolStruct(await grokCallTool(h.url, 'get_decision', { requestId }))
    assert.equal(after.status, 'answered')
    assert.deepEqual(after.editedArgs, editedArgs)
  } finally {
    await h.close()
  }
})

test('grok client: expired is never approval', async () => {
  const host = new FakeHost()
  const h = await startHarness({ host })
  try {
    const created = toolStruct(await grokCallTool(h.url, 'request_approval', { ...baseApproval }))
    host.decide(created.requestId as string, { status: 'expired' })
    const after = toolStruct(await grokCallTool(h.url, 'get_decision', { requestId: created.requestId as string }))
    assert.equal(after.status, 'expired')
    assert.equal(after.value, undefined)
  } finally {
    await h.close()
  }
})

test('grok client: ask_user answer arrives verbatim as answer {kind, value} with no top-level value', async () => {
  const host = new FakeHost()
  const h = await startHarness({ host })
  try {
    const created = toolStruct(
      await grokCallTool(h.url, 'ask_user', {
        idempotencyKey: 'grok-q-0001',
        prompt: 'Which colour variant should ship?',
        answerSchema: { type: 'single', options: ['red', 'green', 'blue'] },
      }),
    )
    assert.equal(created.state, 'pending')
    const requestId = created.requestId as string
    host.decide(requestId, { status: 'decided', decision: 'respond', answer: { kind: 'single', value: 'blue' } })
    const after = toolStruct(await grokCallTool(h.url, 'get_decision', { requestId }))
    assert.equal(after.status, 'answered')
    assert.deepEqual(after.answer, { kind: 'single', value: 'blue' })
    // hitl-spec 4.2 ruling: the typed answer is the only carrier.
    assert.equal(after.value, undefined)
  } finally {
    await h.close()
  }
})

test('grok client: no session affinity — a later call from a cold connection still reads the ask', async () => {
  const host = new FakeHost()
  const h = await startHarness({ host })
  try {
    const created = toolStruct(await grokCallTool(h.url, 'request_approval', { ...baseApproval }))
    host.decide(created.requestId as string, { status: 'decided', decision: 'accept' })
    // A tools/call with no initialize at all must still work: everything the
    // client needs is in the request.
    const call = await postRpc(h.url, TEST_KEY, 'tools/call', {
      name: 'get_decision',
      arguments: { requestId: created.requestId },
    })
    assert.equal(call.res.status, 200)
    assert.equal((call.rpc?.result as { structuredContent: Record<string, unknown> }).structuredContent.status, 'answered')
  } finally {
    await h.close()
  }
})

test('grok client: bad credentials get a Bearer challenge, so Grok can start OAuth', async () => {
  const h = await startHarness()
  try {
    const anon = await postRpc(h.url, null, 'tools/list')
    assert.equal(anon.res.status, 401)
    assert.match(String(anon.res.headers.get('www-authenticate')), /Bearer/)
  } finally {
    await h.close()
  }
})
