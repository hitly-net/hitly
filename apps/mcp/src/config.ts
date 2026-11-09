/**
 * Runtime configuration for the HITLy MCP server. Everything comes from env so the
 * same build runs behind any reverse proxy: the proxy targets HITLY_MCP_HOST:HITLY_MCP_PORT.
 */

export const DEFAULT_PORT = 3006
export const DEFAULT_LISTEN_HOST = '127.0.0.1'
export const DEFAULT_API_URL = 'https://cloud.hitly.net'
export const MCP_PATH = '/mcp'
/** Bot request deadline when the caller passes none (decided 9 Nov 12:31). */
export const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * Host features that land in M0 / M0h. Until a capability is switched on, the server
 * refuses (or reports "not supported by host") instead of pretending it works.
 */
export const HOST_CAPABILITIES = [
  'cb_auth_token', // M0h: Bearer callback auth stored encrypted, never echoed
  'expires_at', // M0: host honours the requested deadline on HTTP ingest
] as const
export type HostCapability = (typeof HOST_CAPABILITIES)[number]

export interface McpConfig {
  listenHost: string
  port: number
  /** Base URL of the HITLy host HTTP API (no trailing slash). */
  apiUrl: string
  /** Base URL used to build reviewer links (`/inbox/:id`). */
  appUrl: string
  /**
   * Public origin of this MCP server (e.g. the URL the reverse proxy serves). When set,
   * requests without callback_url get `${publicUrl}/callbacks/noop` as their resumeUrl,
   * because HTTP ingest requires one. When unset, callback_url is required.
   */
  publicUrl?: string
  capabilities: Set<HostCapability>
}

function trimUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('HITLY_MCP_PORT must be an integer between 0 and 65535')
  }
  return port
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const apiUrl = trimUrl(env.HITLY_API_URL || DEFAULT_API_URL)
  const appUrl = trimUrl(env.HITLY_APP_URL || apiUrl)
  const publicUrl = env.HITLY_MCP_PUBLIC_URL?.trim() ? trimUrl(env.HITLY_MCP_PUBLIC_URL) : undefined
  const capabilities = new Set<HostCapability>()
  for (const item of (env.HITLY_HOST_CAPABILITIES ?? '').split(',')) {
    const name = item.trim()
    if (!name) continue
    if (!(HOST_CAPABILITIES as readonly string[]).includes(name)) {
      throw new Error(`Unknown HITLY_HOST_CAPABILITIES entry: ${name}`)
    }
    capabilities.add(name as HostCapability)
  }
  return {
    listenHost: env.HITLY_MCP_HOST?.trim() || DEFAULT_LISTEN_HOST,
    port: parsePort(env.HITLY_MCP_PORT),
    apiUrl,
    appUrl,
    publicUrl,
    capabilities,
  }
}
