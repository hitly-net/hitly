import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadConfig, type McpConfig } from './config.ts'
import type { ApprovalRead, HostClient, HostResult, IngestResponse } from './host-client.ts'
import { createLogger } from './logger.ts'
import { createMcpHttpServer, type ServerDeps } from './server.ts'

export const TEST_KEY = 'hitly_testkey_AAAAAAAAAAAAAAAAAAAAAAAA'
export const OTHER_KEY = 'hitly_otherkey_BBBBBBBBBBBBBBBBBBBBBBBB'
export const FIXED_NOW = Date.parse('2026-11-09T13:00:00.000Z')

type Row = { id: string; key: string; idempotencyKey: string; body: Record<string, unknown>; read: ApprovalRead }

/**
 * In-memory stand-in for the host HTTP API. `mode: 'today'` mimics hitly main
 * 4b37be6 (key read without v0 fields, no key-scoped list, session-only cancel);
 * `mode: 'm0'` mimics the M0 endpoints the adapter will switch to.
 */
export class FakeHost {
  rows = new Map<string, Row>()
  ingests: { key: string; idempotencyKey: string; body: Record<string, unknown> }[] = []
  reads: { key: string; id: string }[] = []
  cancels: { key: string; id: string; reason?: string }[] = []
  lists: { key: string; projectId?: string }[] = []
  validKeys = new Set([TEST_KEY, OTHER_KEY])
  seq = 0
  constructor(public mode: 'today' | 'm0' = 'today') {}

  clientFor(key: string): HostClient {
    const auth = <T>(fn: () => HostResult<T>): Promise<HostResult<T>> =>
      Promise.resolve(this.validKeys.has(key) ? fn() : { ok: false, status: 401, error: 'Invalid API key', code: 'unauthorized' })
    return {
      ingest: (body, idempotencyKey) =>
        auth<IngestResponse>(() => {
          this.ingests.push({ key, idempotencyKey, body })
          const existing = [...this.rows.values()].find((row) => row.key === key && row.idempotencyKey === idempotencyKey)
          if (existing) return { ok: true, status: 200, data: { id: existing.id, status: existing.read.status, replayed: true, expiresAt: existing.body.expiresAt } }
          const id = `apr_${String(++this.seq).padStart(4, '0')}`
          this.rows.set(id, { id, key, idempotencyKey, body, read: { id, status: 'pending', presentedAt: null } })
          return { ok: true, status: 200, data: { id, status: 'pending', replayed: false } }
        }),
      getApproval: (id) =>
        auth<ApprovalRead>(() => {
          this.reads.push({ key, id })
          const row = this.rows.get(id)
          if (!row || row.key !== key) return { ok: false, status: 404, error: 'Not found', code: 'not_found' }
          return { ok: true, status: 200, data: row.read }
        }),
      listPending: (projectId) =>
        auth<unknown>(() => {
          this.lists.push({ key, projectId })
          if (this.mode === 'today') return { ok: false, status: 405, error: 'Method Not Allowed', code: 'not_supported_by_host' }
          const items = [...this.rows.values()]
            .filter((row) => row.key === key && row.read.status === 'pending')
            .map((row) => ({ id: row.id, kind: row.body.kind, question: row.body.question, prompt: row.body.prompt, createdAt: '2026-11-09T13:00:00.000Z', deadline: row.body.expiresAt }))
          return { ok: true, status: 200, data: { items } }
        }),
      cancel: (id, reason) => {
        this.cancels.push({ key, id, reason })
        if (this.mode === 'today') {
          // Session-only today: a project key is not a session, so the host answers 401.
          return Promise.resolve({ ok: false, status: 401, error: 'Unauthorized', code: 'unauthorized' } as const)
        }
        return auth<unknown>(() => {
          const row = this.rows.get(id)
          if (!row || row.key !== key) return { ok: false, status: 404, error: 'Not found', code: 'not_found' }
          row.read = { ...row.read, status: 'cancelled' }
          return { ok: true, status: 200, data: { id, status: 'cancelled' } }
        })
      },
    }
  }

  decide(id: string, read: Partial<ApprovalRead>) {
    const row = this.rows.get(id)
    if (!row) throw new Error('no row')
    row.read = { ...row.read, ...read, id }
  }
}

export interface Harness {
  url: string
  server: Server
  host: FakeHost
  logs: string[]
  config: McpConfig
  close(): Promise<void>
  client(key?: string | null): Promise<Client>
}

export async function startHarness(opts: { env?: Record<string, string>; host?: FakeHost; deps?: ServerDeps } = {}): Promise<Harness> {
  const config = loadConfig({ HITLY_MCP_PORT: '0', HITLY_API_URL: 'https://hitly.example', ...opts.env })
  const host = opts.host ?? new FakeHost()
  const logs: string[] = []
  const server = createMcpHttpServer(config, {
    logger: createLogger((line) => logs.push(line)),
    hostFor: (key) => host.clientFor(key),
    now: () => FIXED_NOW,
    ...opts.deps,
  })
  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  const clients: Client[] = []
  return {
    url,
    server,
    host,
    logs,
    config,
    async client(key: string | null = TEST_KEY) {
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: key ? { authorization: `Bearer ${key}` } : {} },
      })
      const client = new Client({ name: 'test', version: '0.0.0' })
      await client.connect(transport)
      clients.push(client)
      return client
    },
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent
}

export const baseApproval = {
  idempotencyKey: 'bot-task-0001',
  question: 'Send the refund of £40 to order 1234?',
  action: { name: 'refund', args: { orderId: '1234', amount: 40 } },
  callback_url: 'https://bot.example/hitly/callback',
}
