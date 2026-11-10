/**
 * Child process used by logging.test.ts to prove the real sinks are clean.
 *
 * Starts the real MCP server with the DEFAULT logger (no injected sink, so log lines
 * go to the process's real stdout) and a FakeHost, and announces its ports on fd 3 so
 * stdout/stderr stay pure capture surface. A `console.log(input)` (or console.error)
 * anywhere in the request path therefore lands in what the parent captures.
 *
 * The parent drives tool calls over real HTTP; the only side-channel is
 * GET http://127.0.0.1:<controlPort>/decide/<id>, which decides the request with
 * sentinel edit payloads so get_decision has something to read back.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeSync } from 'node:fs'
import { loadConfig } from './config.ts'
import { createMcpHttpServer } from './server.ts'
import { FakeHost } from './test-helpers.ts'

/** fd 3 is the parent's private announce channel (spawned with 4 stdio entries). */
const announce = (line: string) => writeSync(3, `${line}\n`)

const host = new FakeHost('m0')
const config = loadConfig({
  HITLY_MCP_PORT: '0',
  HITLY_API_URL: 'https://hitly.example',
  HITLY_MCP_PUBLIC_URL: 'https://mcp.hitly.example',
})

// Default sink: createLogger() writes JSON lines to the real process stdout.
const server = createMcpHttpServer(config, { hostFor: (key) => host.clientFor(key) })

const control = createServer((req, res) => {
  const match = /^\/decide\/(apr_\d+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
  if (!match) {
    res.writeHead(404).end()
    return
  }
  try {
    host.decide(match[1], {
      status: 'decided',
      decision: 'edit',
      response: 'SENTINEL_RESPONSE',
      reason: 'SENTINEL_REASON',
      editedArgs: { to: 'SENTINEL_EDITED' },
      answer: { kind: 'free_text', value: 'SENTINEL_ANSWER_VALUE' },
    })
    res.writeHead(204).end()
  } catch {
    res.writeHead(404).end()
  }
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve))
announce(`LISTENING ${(server.address() as AddressInfo).port} ${(control.address() as AddressInfo).port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(0))
}
