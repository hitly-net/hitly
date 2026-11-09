import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { clientIdFor, createLogger } from './logger.ts'
import { baseApproval, FakeHost, startHarness, TEST_KEY } from './test-helpers.ts'

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

/**
 * The in-process tests above inject a sink; this one proves the REAL sinks are clean:
 * the server runs in a child process with the default logger (writes to the real
 * process stdout), and the parent captures that process's stdout AND stderr. A
 * `console.log(input)` (or console.error) anywhere in the request path therefore
 * trips the sentinel and allowlisted-JSON assertions below.
 */
test('real stdout/stderr of the server process carry only allowlisted JSON log lines', async () => {
  const childPath = fileURLToPath(new URL('./log-capture-child.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', childPath], {
    cwd: dirname(childPath),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 60_000)
  watchdog.unref()
  const stdout: string[] = []
  const stderr: string[] = []
  const outStream = child.stdout as Readable
  const errStream = child.stderr as Readable
  outStream.setEncoding('utf8')
  errStream.setEncoding('utf8')
  outStream.on('data', (chunk: string) => stdout.push(chunk))
  errStream.on('data', (chunk: string) => stderr.push(chunk))

  let createdId: string | undefined
  try {
    const ports = await new Promise<{ mcp: number; control: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('log-capture child did not announce its ports')), 30_000)
      const fd3 = child.stdio[3] as unknown as Readable
      fd3.setEncoding('utf8')
      let buf = ''
      fd3.on('data', (chunk: string) => {
        buf += chunk
        const match = /LISTENING (\d+) (\d+)/.exec(buf)
        if (match) {
          clearTimeout(timer)
          resolve({ mcp: Number(match[1]), control: Number(match[2]) })
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`log-capture child exited early (code ${code}): ${stderr.join('')}`))
      })
    })

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ports.mcp}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TEST_KEY}` } },
    })
    const client = new Client({ name: 'log-capture', version: '0.0.0' })
    try {
      await client.connect(transport)
      const created = await client.callTool({
        name: 'request_approval',
        arguments: {
          idempotencyKey: 'bot-task-realstdout-0001',
          question: SENTINELS.question,
          context: SENTINELS.context,
          action: { name: 'pay', args: { to: SENTINELS.arg } },
          callback_url: SENTINELS.callback,
        },
      })
      createdId = (created.structuredContent as { requestId: string }).requestId
      await client.callTool({
        name: 'ask_user',
        arguments: {
          idempotencyKey: 'bot-ask-realstdout-0001',
          prompt: SENTINELS.prompt,
          detail: SENTINELS.detail,
          answerSchema: { type: 'single_choice', options: [SENTINELS.option] },
          callback_url: SENTINELS.callback,
        },
      })
      await client.callTool({
        name: 'ask_user',
        arguments: {
          idempotencyKey: 'bot-ask-realstdout-0002',
          prompt: SENTINELS.prompt,
          detail: `${SENTINELS.detail} ${'x'.repeat(8_001)}`,
          answerSchema: { type: 'free_text' },
          callback_url: SENTINELS.callback,
        },
      })
      const decided = await fetch(`http://127.0.0.1:${ports.control}/decide/${createdId}`)
      assert.equal(decided.status, 204)
      await client.callTool({ name: 'get_decision', arguments: { requestId: createdId } })
      await client.callTool({
        name: 'request_approval',
        arguments: { ...baseApproval, idempotencyKey: 'bot-task-realstdout-0002', question: 'SENTINEL_BAD.' },
      })
      await client.callTool({ name: 'get_decision', arguments: { requestId: 'SENTINEL ID WITH SPACES' } })
      await fetch(`http://127.0.0.1:${ports.mcp}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer SENTINEL_BADKEY' },
        body: '{}',
      })
    } finally {
      await client.close().catch(() => undefined)
    }
  } finally {
    child.kill('SIGKILL')
    clearTimeout(watchdog)
  }

  const out = stdout.join('')
  const all = out + stderr.join('')
  // Proof the capture is the real sink and the logger really wrote to it.
  assert.ok(out.includes(clientIdFor(TEST_KEY)), 'real stdout must contain the logger JSON lines')
  assert.ok(createdId !== undefined && out.includes(createdId))
  // Nothing else may appear on either stream.
  assert.equal(all.includes(TEST_KEY), false)
  assert.doesNotMatch(all, /SENTINEL/)
  for (const value of Object.values(SENTINELS)) assert.equal(all.includes(value), false, value)
  // Every stdout line is an allowlisted JSON log line; a raw console.log(input) fails here.
  const allowed = new Set(['ts', 'event', 'tool', 'requestId', 'status', 'latencyMs', 'clientId', 'port'])
  const lines = out.split('\n').filter((line) => line.trim())
  assert.ok(lines.length >= 8, `expected tool+http log lines, got ${String(lines.length)}`)
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `unexpected log field ${key}`)
  }
})
