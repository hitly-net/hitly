import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MAX_BODY_BYTES, MCP_PATH, type McpConfig } from './config.ts'
import { HttpHostClient, type FetchLike, type HostClient } from './host-client.ts'
import { clientIdFor, createLogger, type Logger } from './logger.ts'
import { createRateLimiter } from './rate-limit.ts'
import { hostHeaderAllowed, isLoopbackBind, originAllowed } from './security.ts'
import { registerTools } from './tools.ts'

export const SERVER_NAME = 'hitly'
export const SERVER_VERSION = '0.0.1'

export interface ServerDeps {
  logger?: Logger
  /** Override how a host client is built for a key (tests). */
  hostFor?: (apiKey: string) => HostClient
  fetchImpl?: FetchLike
  now?: () => number
  /** Clock for the rate limiter (tests); defaults to wall time. */
  rateNow?: () => number
}

/** Project API keys look like `hitly_<base64url>`; resume tokens (`hitly_resume_…`) are not API keys. */
const API_KEY_PATTERN = /^hitly_[A-Za-z0-9_-]{16,128}$/

/** Where a plain browser visit to the MCP endpoint is sent. */
export const MCP_DOCS_URL = 'https://hitly.net/docs/mcp'

/**
 * True when this looks like a person typing the URL into a browser rather than an
 * MCP client: GET, Accept wants HTML, no credentials, and not an SSE stream request
 * (MCP clients may send `text/event-stream` together with `text/html`).
 */
export function isBrowserVisit(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false
  if (req.headers.authorization) return false
  const accept = (req.headers.accept ?? '').toLowerCase()
  return accept.includes('text/html') && !accept.includes('text/event-stream')
}

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
        'HITLy routes asks to a human reviewer. request_approval and ask_user return immediately (pending). Never treat pending, expired or cancelled as approval. Confirm with get_decision before acting; if editedArgs is present, act on those. The typed ask_user answer comes back from get_decision as answer {kind, value}; use it verbatim. callback_url (https, with optional cb_auth_token sent back as Authorization: Bearer) gets a POST when the outcome is known, but the callback is only a hint - get_decision is the source of truth; if you don\'t pass callback_url you won\'t receive a callback, so poll get_decision. Ask one question per ask_user request (hitl/v0 answers exactly one ask); simple_form is refused with an error - send a separate ask_user for each field.',
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
 *
 * Musts (MCP spec) enforced here: Origin validation with an operator allowlist, Host
 * validation while bound to loopback (DNS-rebinding defence), and a per-API-key rate
 * limit answering 429 with Retry-After.
 */
export function createMcpHttpServer(config: McpConfig, deps: ServerDeps = {}): Server {
  const logger = deps.logger ?? createLogger()
  const loopbackBound = isLoopbackBind(config.listenHost)
  const originPolicy = {
    allowedOrigins: new Set(config.allowedOrigins),
    publicUrlOrigin: config.publicUrlOrigin,
    loopbackBound,
  }
  const rateLimiter = createRateLimiter(config.rateLimit, config.rateWindowMs, deps.rateNow ?? Date.now)
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
      if ((url.pathname === MCP_PATH || url.pathname === `${MCP_PATH}/`) && isBrowserVisit(req)) {
        // A person opened the machine endpoint in a browser: point them at the docs.
        logger.log({ event: 'browser_redirect' })
        res.writeHead(302, { location: MCP_DOCS_URL, 'cache-control': 'no-store' }).end()
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
      // DNS-rebinding defences run before any credential is handled.
      if (loopbackBound && !hostHeaderAllowed(req.headers.host)) {
        req.resume()
        logger.log({ event: 'auth', status: 'host_denied' })
        jsonRpcError(res, 403, -32003, 'Forbidden: Host not allowed')
        return
      }
      if (!originAllowed(req.headers.origin, originPolicy)) {
        req.resume()
        logger.log({ event: 'auth', status: 'origin_denied' })
        jsonRpcError(res, 403, -32003, 'Forbidden: Origin not allowed')
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
      const budget = rateLimiter.tryConsume(clientIdFor(auth.key))
      if (!budget.ok) {
        req.resume()
        const retryAfterSec = Math.max(1, Math.ceil(budget.retryAfterMs / 1000))
        logger.log({ event: 'rate_limit', clientId: clientIdFor(auth.key), status: 'rate_limited' })
        jsonRpcError(res, 429, -32005, 'Rate limit exceeded; retry later', { 'retry-after': String(retryAfterSec) })
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
