import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MAX_BODY_BYTES, MCP_PATH, type McpConfig } from './config.ts'
import { HttpHostClient, type FetchLike, type HostClient } from './host-client.ts'
import { clientIdFor, createLogger, type Logger } from './logger.ts'
import { registerTools } from './tools.ts'

export const SERVER_NAME = 'hitly'
export const SERVER_VERSION = '0.0.1'

export interface ServerDeps {
  logger?: Logger
  /** Override how a host client is built for a key (tests). */
  hostFor?: (apiKey: string) => HostClient
  fetchImpl?: FetchLike
  now?: () => number
}

/** Project API keys look like `hitly_<base64url>`; resume tokens (`hitly_resume_…`) are not API keys. */
const API_KEY_PATTERN = /^hitly_[A-Za-z0-9_-]{16,128}$/

export function extractApiKey(header: string | undefined): { key: string } | { error: 'missing' | 'invalid' } {
  if (!header) return { error: 'missing' }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!match) return { error: 'invalid' }
  const key = match[1]
  if (!API_KEY_PATTERN.test(key) || key.startsWith('hitly_resume_')) return { error: 'invalid' }
  return { key }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers)
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: 'Request body too large' }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return { ok: false, status: 400, message: 'JSON-RPC body required' }
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, message: 'Parse error' }
  }
}

export function buildMcpServer(config: McpConfig, apiKey: string, deps: ServerDeps, logger: Logger) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'HITLy routes asks to a human reviewer. request_approval and ask_user return immediately (pending). Never treat pending, expired or cancelled as approval. Confirm with get_decision before acting; if editedArgs is present, act on those.',
    },
  )
  const host = deps.hostFor ? deps.hostFor(apiKey) : new HttpHostClient(config.apiUrl, apiKey, deps.fetchImpl)
  registerTools(server, { config, host, logger, clientId: clientIdFor(apiKey), now: deps.now })
  return server
}

/**
 * Streamable HTTP MCP endpoint at /mcp, stateless (no MCP session state; every POST
 * carries its own API key), so a restart never loses anything: create-once lives on
 * the host. Also serves GET /healthz and the no-op callback sink.
 */
export function createMcpHttpServer(config: McpConfig, deps: ServerDeps = {}): Server {
  const logger = deps.logger ?? createLogger()
  return createServer(async (req, res) => {
    const started = Date.now()
    res.on('finish', () => {
      logger.log({ event: 'http', status: res.statusCode, latencyMs: Date.now() - started })
    })
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (url.pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok' })
        return
      }
      if (url.pathname === '/callbacks/noop') {
        // Sink for requests made without callback_url. Body is discarded unread.
        req.resume()
        res.writeHead(req.method === 'POST' ? 204 : 405).end()
        return
      }
      if (url.pathname !== MCP_PATH) {
        sendJson(res, 404, { error: 'Not found' })
        return
      }
      if (req.method !== 'POST') {
        // Stateless server: no server-initiated SSE stream and no sessions to delete.
        jsonRpcError(res, 405, -32000, 'Method not allowed', { allow: 'POST' })
        return
      }
      const auth = extractApiKey(req.headers.authorization)
      if ('error' in auth) {
        req.resume()
        logger.log({ event: 'auth', status: auth.error === 'missing' ? 'missing_key' : 'invalid_key' })
        jsonRpcError(res, 401, -32001, auth.error === 'missing' ? 'Missing API key' : 'Invalid API key', {
          'www-authenticate': 'Bearer realm="hitly-mcp"',
        })
        return
      }
      const parsed = await readBody(req)
      if (!parsed.ok) {
        jsonRpcError(res, parsed.status, -32700, parsed.message)
        return
      }
      const server = buildMcpServer(config, auth.key, deps, logger)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, parsed.body)
    } catch {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal error')
    }
  })
}
