/**
 * Destination check.
 *
 * Shared validation for every outbound target the server contacts because of
 * stored configuration: the HTTP and S3 evidence sinks, OTEL exporter
 * endpoints, and plugin baseUrl settings. It:
 *   1. validates the URL (http/https only, no embedded credentials),
 *   2. resolves the host once and checks every returned address,
 *   3. connects to the checked address (original Host header and TLS server
 *      name kept) and does not follow redirects,
 *   4. applies a connect timeout, a total timeout and a response size cap,
 *   5. reports errors with a fixed message, the status code and the host only.
 *
 * Private and loopback targets are allowed when NODE_ENV is not "production".
 * In production they are allowed only when the server environment variable
 * HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS is exactly "true". The flag is read from
 * the server environment only, never from workspace or project settings.
 *
 * Node only: import from "@hitly/core/destination-check".
 */
import { promises as dns } from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'

export const DESTINATION_ALLOW_PRIVATE_FLAG = 'HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS'

/** Time allowed to establish the connection. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
/** Time allowed for the whole exchange, from lookup to the last response byte. */
export const DEFAULT_TOTAL_TIMEOUT_MS = 10_000
/** Most response bytes read before the request is aborted (1 MiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

type Env = Record<string, string | undefined>

export interface DestinationPolicy {
  /** When false, private, loopback and link-local destinations are refused. */
  allowPrivate: boolean
  /** True when the policy came from a production environment. */
  production: boolean
}

export function resolveDestinationPolicy(env: Env = process.env): DestinationPolicy {
  const production = env.NODE_ENV === 'production'
  if (!production) return { allowPrivate: true, production }
  return { allowPrivate: env[DESTINATION_ALLOW_PRIVATE_FLAG] === 'true', production }
}

/** One neutral line for server start, or null when there is nothing to say. */
export function destinationPolicyStartupNotice(env: Env = process.env): string | null {
  const policy = resolveDestinationPolicy(env)
  if (policy.production && policy.allowPrivate) {
    return `[hitly] Private destinations are allowed for evidence sinks, telemetry and plugins (${DESTINATION_ALLOW_PRIVATE_FLAG}=true).`
  }
  return null
}

export type DestinationCheckCode =
  | 'bad_url'
  | 'scheme'
  | 'userinfo'
  | 'resolve'
  | 'refused'
  | 'redirect'
  | 'size'
  | 'timeout'
  | 'connect'
  | 'aborted'

export class DestinationCheckError extends Error {
  readonly code: DestinationCheckCode
  readonly host?: string
  readonly status?: number

  constructor(code: DestinationCheckCode, message: string, host?: string, status?: number) {
    super(message)
    this.name = 'DestinationCheckError'
    this.code = code
    this.host = host
    this.status = status
  }
}

function hostPart(host?: string): string {
  return host ? ` (host "${host}")` : ''
}

function refusedError(host: string, policy: DestinationPolicy): DestinationCheckError {
  const hint = policy.allowPrivate
    ? ''
    : ` Private destinations are allowed in production only when the server sets ${DESTINATION_ALLOW_PRIVATE_FLAG}=true.`
  return new DestinationCheckError('refused', `Destination check: this address is not allowed${hostPart(host)}.${hint}`, host)
}

function failure(code: DestinationCheckCode, reason: string, host?: string, status?: number) {
  const statusPart = status !== undefined ? ` (status ${status})` : ''
  return new DestinationCheckError(code, `Destination check: ${reason}${statusPart}${hostPart(host)}.`, host, status)
}

/** Fixed message for a non-2xx answer; never includes the response body. */
export function destinationStatusMessage(label: string, status: number, host: string): string {
  return `${label} failed (${status})${host ? ` for host "${host}"` : ''}.`
}

/** Message safe to show or log for any error raised while sending. */
export function destinationErrorMessage(label: string, error: unknown, host?: string): string {
  if (error instanceof DestinationCheckError) return error.message
  return `${label} failed: connection error${hostPart(host)}.`
}

// --- address ranges ---------------------------------------------------------

function v4Number(bytes: ArrayLike<number>): number {
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
}

function inV4(n: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n & mask) >>> 0) === ((base & mask) >>> 0)
}

/** Private, loopback, unspecified, shared and link-local IPv4 ranges. */
const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
]

function v4Refused(n: number, policy: DestinationPolicy): boolean {
  if (inV4(n, 0xe0000000, 4)) return true // multicast 224.0.0.0/4
  if (n === 0xffffffff) return true // broadcast
  if (policy.allowPrivate) return false
  return PRIVATE_V4.some(([base, bits]) => inV4(n, base, bits))
}

function parseV4(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    out.push(value)
  }
  return out
}

/** Expands an IPv6 literal (no brackets) to 16 bytes, or null. */
export function expandIPv6(input: string): Uint8Array | null {
  let text = input.toLowerCase()
  if (text.includes('%')) text = text.slice(0, text.indexOf('%'))
  const lastColon = text.lastIndexOf(':')
  if (text.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(text.slice(lastColon + 1))
    if (!v4) return null
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const groups: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      groups.push(parseInt(group, 16))
    }
    return groups
  }
  const left = parse(halves[0])
  const right = halves.length === 2 ? parse(halves[1]) : []
  if (!left || !right) return null
  let groups: number[]
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length
    if (missing < 1) return null
    groups = [...left, ...new Array<number>(missing).fill(0), ...right]
  } else {
    if (left.length !== 8) return null
    groups = left
  }
  const bytes = new Uint8Array(16)
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8
    bytes[i * 2 + 1] = group & 0xff
  })
  return bytes
}

function zeros(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false
  return true
}

function v6Refused(bytes: Uint8Array, policy: DestinationPolicy): boolean {
  if (bytes[0] === 0xff) return true // multicast ff00::/8
  if (zeros(bytes, 0, 15) && (bytes[15] === 0 || bytes[15] === 1)) return !policy.allowPrivate // :: and ::1
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96
  if (zeros(bytes, 0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) {
    return v4Refused(v4Number(bytes.subarray(12, 16)), policy)
  }
  // 64:ff9b::/96 (embedded IPv4 in the last 32 bits)
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(bytes, 4, 12)) {
    return v4Refused(v4Number(bytes.subarray(12, 16)), policy)
  }
  // 2002::/16 (embedded IPv4 in bits 16-47)
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4Refused(v4Number(bytes.subarray(2, 6)), policy)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return !policy.allowPrivate // fe80::/10
  if ((bytes[0] & 0xfe) === 0xfc) return !policy.allowPrivate // fc00::/7
  return false
}

/** True when the IP literal is refused under the policy. Non-IP input is refused. */
export function addressRefused(address: string, policy: DestinationPolicy): boolean {
  const host = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const family = net.isIP(host)
  if (family === 4) {
    const v4 = parseV4(host)
    return v4 ? v4Refused(v4Number(v4), policy) : true
  }
  if (family === 6) {
    const bytes = expandIPv6(host)
    return bytes ? v6Refused(bytes, policy) : true
  }
  return true
}

// --- host and URL -----------------------------------------------------------

/**
 * Lower-cases, strips brackets and one trailing dot, and turns the other IPv4
 * spellings (decimal, octal, hex, short forms) into dotted decimal.
 */
export function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host && !net.isIP(host) && /^[0-9a-fx.]+$/.test(host)) {
    try {
      const canonical = new URL(`http://${host}/`).hostname
      if (net.isIP(canonical)) host = canonical
    } catch {
      // not an IPv4 spelling; treated as a name
    }
  }
  return host
}

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost')
}

export interface CheckedUrl {
  url: URL
  host: string
  port: number
}

/** Validates the URL without contacting it. */
export function parseCheckedUrl(input: string | URL, policy: DestinationPolicy): CheckedUrl {
  let url: URL
  try {
    url = new URL(typeof input === 'string' ? input.trim() : input.href)
  } catch {
    throw failure('bad_url', 'the URL is not valid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw failure('scheme', 'only http and https URLs are allowed')
  }
  const host = normalizeHost(url.hostname)
  if (url.username || url.password) {
    throw failure('userinfo', 'URLs with a user name or password are not allowed', host)
  }
  if (!host) throw failure('bad_url', 'the URL is not valid')
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  if (net.isIP(host)) {
    if (addressRefused(host, policy)) throw refusedError(host, policy)
  } else if (isLocalhostName(host) && !policy.allowPrivate) {
    throw refusedError(host, policy)
  }
  return { url, host, port }
}

export type ResolveAddresses = (host: string) => Promise<Array<{ address: string; family?: number }>>

const defaultResolve: ResolveAddresses = (host) => dns.lookup(host, { all: true, verbatim: true })

/** Resolves once and checks every answer. The first answer is the one to connect to. */
export async function resolveAndCheck(
  host: string,
  policy: DestinationPolicy,
  resolveAddresses: ResolveAddresses = testHooks.resolve ?? defaultResolve,
): Promise<string[]> {
  if (net.isIP(host)) return [host]
  let records: Array<{ address: string; family?: number }>
  try {
    records = await resolveAddresses(host)
  } catch {
    throw failure('resolve', 'the host name could not be resolved', host)
  }
  const addresses = (records ?? []).map((record) => record?.address).filter((a): a is string => typeof a === 'string' && a.length > 0)
  if (addresses.length === 0) throw failure('resolve', 'the host name could not be resolved', host)
  for (const address of addresses) {
    if (addressRefused(address, policy)) throw refusedError(host, policy)
  }
  return addresses
}

/** Save-time check. Sending runs the same checks again. */
export async function assertDestinationAllowed(
  input: string | URL,
  options: { policy?: DestinationPolicy; resolveAddresses?: ResolveAddresses } = {},
): Promise<CheckedUrl> {
  const policy = options.policy ?? resolveDestinationPolicy()
  const target = parseCheckedUrl(input, policy)
  await resolveAndCheck(target.host, policy, options.resolveAddresses)
  return target
}

/**
 * Check for "host:port" style addresses used by gRPC clients (Temporal,
 * OpenShell). These clients resolve the name themselves, so this is a
 * check before connecting, not a pinned connection.
 */
export async function assertHostPortAllowed(
  address: string,
  options: { policy?: DestinationPolicy; resolveAddresses?: ResolveAddresses } = {},
): Promise<CheckedUrl> {
  let hostPort = address.trim()
  const scheme = hostPort.match(/^[a-z][a-z0-9+.-]*:\/\//i)
  if (scheme) hostPort = hostPort.slice(scheme[0].length)
  hostPort = hostPort.replace(/^\/+/, '').split('/')[0]
  return assertDestinationAllowed(`http://${hostPort}/`, options)
}

/** Host for messages; never the full URL. */
export function destinationHost(input: string | URL): string {
  try {
    return normalizeHost(new URL(typeof input === 'string' ? input : input.href).hostname)
  } catch {
    return ''
  }
}

// --- sending ----------------------------------------------------------------

export interface CheckedFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  signal?: AbortSignal
}

export interface CheckedFetchOptions {
  policy?: DestinationPolicy
  resolveAddresses?: ResolveAddresses
  connectTimeoutMs?: number
  totalTimeoutMs?: number
  maxResponseBytes?: number
}

/** A request already checked, ready to be sent to `address`. */
export interface PinnedRequest {
  url: URL
  host: string
  port: number
  address: string
  method: string
  headers: Record<string, string>
  body?: Uint8Array
  /** The body as the caller passed it (used by globalFetchTransport). */
  callerBody?: string | Uint8Array
  connectTimeoutMs: number
  maxResponseBytes: number
  signal: AbortSignal
}

export interface PinnedResponse {
  status: number
  statusText: string
  headers: Headers
  body: Uint8Array
}

export type DestinationTransport = (request: PinnedRequest) => Promise<PinnedResponse>

interface TestHooks {
  resolve?: ResolveAddresses
  transport?: DestinationTransport
}

const testHooks: TestHooks = {}

/**
 * Test seam: replace name resolution and/or the socket layer. The URL and
 * address checks, redirect rule, size cap and messages still apply. Call with
 * no argument to restore the defaults.
 */
export function setDestinationCheckTestHooks(hooks: TestHooks = {}): void {
  testHooks.resolve = hooks.resolve
  testHooks.transport = hooks.transport
}

/**
 * Transport for tests that mock `globalThis.fetch`: hands the checked request
 * to the current global fetch instead of opening a socket.
 */
export const globalFetchTransport: DestinationTransport = async (request) => {
  // Mocks often return a partial Response, so read it defensively.
  const response = (await globalThis.fetch(request.url.href, {
    method: request.method,
    headers: request.headers,
    body: (request.callerBody ?? request.body) as BodyInit | undefined,
    redirect: 'manual',
    signal: request.signal,
  })) as Partial<Response>
  let body: Uint8Array
  if (typeof response.arrayBuffer === 'function') body = new Uint8Array(await response.arrayBuffer())
  else if (typeof response.text === 'function') body = new TextEncoder().encode(await response.text())
  else body = new Uint8Array(0)
  const status = typeof response.status === 'number' ? response.status : response.ok === false ? 500 : 200
  const headers = response.headers instanceof Headers ? response.headers : new Headers((response.headers as HeadersInit) ?? {})
  return { status, statusText: response.statusText ?? '', headers, body }
}

/** Opens the socket to the checked address while keeping Host and TLS server name. */
export const pinnedNodeTransport: DestinationTransport = (request) =>
  new Promise<PinnedResponse>((resolve, reject) => {
    const family = net.isIP(request.address) || 4
    const lookup = (_hostname: string, options: { all?: boolean } | unknown, callback: (...args: unknown[]) => void) => {
      const cb = typeof options === 'function' ? (options as typeof callback) : callback
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all
      if (all) cb(null, [{ address: request.address, family }])
      else cb(null, request.address, family)
    }
    const transport = request.url.protocol === 'https:' ? https : http
    let done = false
    const finish = (error: DestinationCheckError | null, value?: PinnedResponse) => {
      if (done) return
      done = true
      clearTimeout(connectTimer)
      request.signal.removeEventListener('abort', onAbort)
      if (error) {
        req.destroy()
        reject(error)
      } else resolve(value!)
    }
    const onAbort = () => finish(failure('aborted', 'the request was stopped', request.host))
    const req = transport.request({
      host: request.host,
      port: request.port,
      path: `${request.url.pathname}${request.url.search}`,
      method: request.method,
      headers: request.headers,
      lookup: lookup as unknown as http.RequestOptions['lookup'],
      agent: false,
      ...(request.url.protocol === 'https:' && !net.isIP(request.host) ? { servername: request.host } : {}),
    })
    const connectTimer = setTimeout(
      () => finish(failure('timeout', 'the connection timed out', request.host)),
      request.connectTimeoutMs,
    )
    req.on('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer))
    })
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    req.on('error', () => finish(failure('connect', 'the connection failed', request.host)))
    req.on('response', (res) => {
      const status = res.statusCode ?? 0
      const headers = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
        else if (typeof value === 'string') headers.append(key, value)
      }
      if (status >= 300 && status < 400) {
        res.destroy()
        finish(null, { status, statusText: res.statusMessage ?? '', headers, body: new Uint8Array(0) })
        return
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > request.maxResponseBytes) {
        res.destroy()
        finish(failure('size', `the response is larger than ${request.maxResponseBytes} bytes`, request.host, status))
        return
      }
      const chunks: Buffer[] = []
      let read = 0
      res.on('data', (chunk: Buffer) => {
        read += chunk.length
        if (read > request.maxResponseBytes) {
          res.destroy()
          finish(failure('size', `the response is larger than ${request.maxResponseBytes} bytes`, request.host, status))
          return
        }
        chunks.push(chunk)
      })
      res.on('error', () => finish(failure('connect', 'the connection failed', request.host)))
      res.on('end', () => {
        finish(null, { status, statusText: res.statusMessage ?? '', headers, body: new Uint8Array(Buffer.concat(chunks)) })
      })
    })
    if (request.body) req.end(Buffer.from(request.body))
    else req.end()
  })

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

/**
 * Sends a request to a checked destination and returns a standard Response.
 * Any 3xx answer is an error and the Location is never contacted. Non-2xx
 * answers are returned; callers report them with destinationStatusMessage().
 */
export async function checkedFetch(
  input: string | URL,
  init: CheckedFetchInit = {},
  options: CheckedFetchOptions = {},
): Promise<Response> {
  const policy = options.policy ?? resolveDestinationPolicy()
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const controller = new AbortController()
  let timedOut = false
  const totalTimer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, totalTimeoutMs)
  const onCallerAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onCallerAbort, { once: true })
  if (init.signal?.aborted) controller.abort()

  try {
    const target = parseCheckedUrl(input, policy)
    const stopped = new Promise<never>((_, reject) => {
      const onStop = () =>
        reject(timedOut ? failure('timeout', 'the request timed out', target.host) : failure('aborted', 'the request was stopped', target.host))
      if (controller.signal.aborted) onStop()
      else controller.signal.addEventListener('abort', onStop, { once: true })
    })
    stopped.catch(() => {})
    const addresses = await Promise.race([resolveAndCheck(target.host, policy, options.resolveAddresses), stopped])
    if (controller.signal.aborted) {
      throw timedOut ? failure('timeout', 'the request timed out', target.host) : failure('aborted', 'the request was stopped', target.host)
    }
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    const body = init.body === undefined ? undefined : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : init.body
    if (body) headers['content-length'] = String(body.byteLength)
    const transport = testHooks.transport ?? pinnedNodeTransport
    let response: PinnedResponse
    try {
      response = await transport({
        url: target.url,
        host: target.host,
        port: target.port,
        address: addresses[0],
        method: (init.method ?? 'GET').toUpperCase(),
        headers,
        body,
        callerBody: init.body,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        maxResponseBytes,
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) throw failure('timeout', 'the request timed out', target.host)
      if (error instanceof DestinationCheckError) throw error
      if (controller.signal.aborted) throw failure('aborted', 'the request was stopped', target.host)
      throw failure('connect', 'the connection failed', target.host)
    }
    if (response.status >= 300 && response.status < 400) {
      throw failure('redirect', 'redirects are not followed', target.host, response.status)
    }
    if (response.body.byteLength > maxResponseBytes) {
      throw failure('size', `the response is larger than ${maxResponseBytes} bytes`, target.host, response.status)
    }
    const status = response.status >= 200 && response.status <= 599 ? response.status : 502
    return new Response(NULL_BODY_STATUS.has(status) ? null : (response.body as BodyInit), {
      status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } finally {
    clearTimeout(totalTimer)
    init.signal?.removeEventListener('abort', onCallerAbort)
  }
}
