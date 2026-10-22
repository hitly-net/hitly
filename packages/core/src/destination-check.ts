/**
 * Destination check.
 *
 * Shared validation for every outbound target the server contacts because of
 * stored configuration: the HTTP and S3 evidence sinks, OTEL exporter
 * endpoints, and plugin baseUrl settings. It:
 *   1. validates the URL (http/https only, no embedded credentials),
 *   2. resolves the host once and checks every returned address,
 *   3. connects to a checked address, trying each answer in order until one
 *      connects (original Host header and TLS server name kept), and does not
 *      follow redirects,
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
import { type AddressClass, classifyAddress, parseIPv6 } from './address-classify.ts'

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

/** Expands an IPv6 literal (no brackets) to 16 bytes, or null. */
export function expandIPv6(input: string): Uint8Array | null {
  const groups = parseIPv6(input)
  if (!groups) return null
  const bytes = new Uint8Array(16)
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8
    bytes[i * 2 + 1] = group & 0xff
  })
  return bytes
}

/**
 * Multicast and broadcast are refused in every environment. Other non-public
 * addresses are refused unless the policy allows private destinations.
 */
function classRefused(kind: AddressClass, policy: DestinationPolicy): boolean {
  if (kind === 'multicast') return true
  if (kind === 'private') return !policy.allowPrivate
  return false
}

/** True when the IP literal is refused under the policy. Non-IP input is refused. */
export function addressRefused(address: string, policy: DestinationPolicy): boolean {
  const host = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  if (!net.isIP(host)) return true
  const kind = classifyAddress(host)
  return kind ? classRefused(kind, policy) : true
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

/** Resolves once and checks every answer. Answers are tried in order when sending. */
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

/** Target prefixes a gRPC client reads as something other than a host name. */
const CLIENT_TARGET_PREFIXES = new Set(['dns', 'unix', 'unix-abstract', 'ipv4', 'ipv6', 'vsock', 'xds'])

const NAME_PORT = /^([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_.])?):([0-9]{1,5})$/
const BRACKETED_PORT = /^\[([0-9A-Fa-f:.]+)\]:([0-9]{1,5})$/

/**
 * Splits a bare "host:port" or "[IPv6]:port" address. Anything else (a
 * scheme or prefix, a path, user info, spaces, a missing or out-of-range
 * port) is refused, so the address is read the same way here and by the
 * client.
 */
export function parseHostPort(address: string): { host: string; port: number } {
  const invalid = () => failure('bad_url', 'the address must be host:port or [IPv6]:port')
  if (typeof address !== 'string') throw invalid()
  let host: string
  let portText: string
  const bracketed = address.match(BRACKETED_PORT)
  if (bracketed) {
    if (!net.isIPv6(bracketed[1])) throw invalid()
    host = `[${bracketed[1]}]`
    portText = bracketed[2]
  } else {
    const named = address.match(NAME_PORT)
    if (!named) throw invalid()
    if (CLIENT_TARGET_PREFIXES.has(named[1].toLowerCase())) throw invalid()
    host = named[1]
    portText = named[2]
  }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid()
  return { host, port }
}

/**
 * Check for "host:port" addresses used by gRPC clients (Temporal, OpenShell).
 * Only a bare host:port or [IPv6]:port is accepted. These clients resolve the
 * name themselves, so this is a check before connecting, not a pinned
 * connection.
 */
export async function assertHostPortAllowed(
  address: string,
  options: { policy?: DestinationPolicy; resolveAddresses?: ResolveAddresses } = {},
): Promise<CheckedUrl> {
  const { host, port } = parseHostPort(address)
  return assertDestinationAllowed(`http://${host}:${port}/`, options)
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

/** Errors raised before a connection was made; the next checked address may be tried. */
const notConnectedErrors = new WeakSet<object>()

function markNotConnected<T extends object>(error: T): T {
  notConnectedErrors.add(error)
  return error
}

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
  const headers = response.headers instanceof Headers ? response.headers : new Headers((response.headers as unknown as HeadersInit | undefined) ?? {})
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
    let connected = false
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
      () => finish(markNotConnected(failure('timeout', 'the connection timed out', request.host))),
      request.connectTimeoutMs,
    )
    req.on('socket', (socket) => {
      socket.once('connect', () => {
        connected = true
        clearTimeout(connectTimer)
      })
    })
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    req.on('error', () => {
      const error = failure('connect', 'the connection failed', request.host)
      finish(connected ? error : markNotConnected(error))
    })
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
    // Every answer was checked above. Try them in order; move on only when no
    // connection was made, so a request is never sent twice.
    let response: PinnedResponse | undefined
    let lastError: unknown
    for (const address of addresses) {
      if (addressRefused(address, policy)) throw refusedError(target.host, policy)
      try {
        response = await transport({
          url: target.url,
          host: target.host,
          port: target.port,
          address,
          method: (init.method ?? 'GET').toUpperCase(),
          headers,
          body,
          callerBody: init.body,
          connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          maxResponseBytes,
          signal: controller.signal,
        })
        break
      } catch (error) {
        lastError = error
        if (timedOut || controller.signal.aborted) break
        if (typeof error === 'object' && error !== null && notConnectedErrors.has(error)) continue
        break
      }
    }
    if (!response) {
      if (timedOut) throw failure('timeout', 'the request timed out', target.host)
      if (lastError instanceof DestinationCheckError) throw lastError
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
