/**
 * Runtime configuration for the HITLy MCP server. Everything comes from env so the
 * same build runs behind any reverse proxy: the proxy targets HITLY_MCP_HOST:HITLY_MCP_PORT.
 */

import { normaliseOrigin } from './security.ts'

export const DEFAULT_PORT = 3006
export const DEFAULT_LISTEN_HOST = '127.0.0.1'
export const DEFAULT_API_URL = 'https://cloud.hitly.net'
export const MCP_PATH = '/mcp'
/** Bot request deadline when the caller passes none (decided 9 Nov 12:31). */
export const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000
/** Deadline cap: a bot cannot schedule an ask further out than 30 days. */
export const MAX_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_BODY_BYTES = 1024 * 1024
/** Per-API-key request budget per window (PM ruling: required before dogfood). */
export const DEFAULT_RATE_LIMIT = 120
export const DEFAULT_RATE_WINDOW_MS = 60_000

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
   * Public origin of this MCP server (e.g. the URL the reverse proxy serves).
   * Used only for the /mcp Origin allowlist (its origin is always allowed).
   * It is never used to synthesise a resumeUrl: requests without callback_url
   * store no resumeUrl and HITLy attempts no callback at all.
   */
  publicUrl?: string
  /** Origin of publicUrl, when set; auto-allowed on /mcp. */
  publicUrlOrigin?: string
  /** Exact origins from HITLY_MCP_ALLOWED_ORIGINS (besides loopback when bound to it). */
  allowedOrigins: string[]
  /** Requests per key per window; 0 disables. */
  rateLimit: number
  rateWindowMs: number
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

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  const out = new Set<string>()
  for (const item of raw.split(',')) {
    const trimmed = item.trim()
    if (!trimmed) continue
    const normalised = normaliseOrigin(trimmed)
    if (normalised === null) {
      throw new Error(`HITLY_MCP_ALLOWED_ORIGINS entries must be http(s) origins without a path, got: ${trimmed}`)
    }
    out.add(normalised)
  }
  return [...out]
}

function parseRate(raw: string | undefined, fallback: number, name: string, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer of at least ${min}`)
  }
  return value
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
    publicUrlOrigin: publicUrl ? new URL(publicUrl).origin : undefined,
    allowedOrigins: parseAllowedOrigins(env.HITLY_MCP_ALLOWED_ORIGINS),
    rateLimit: parseRate(env.HITLY_MCP_RATE_LIMIT, DEFAULT_RATE_LIMIT, 'HITLY_MCP_RATE_LIMIT', 0),
    rateWindowMs: parseRate(env.HITLY_MCP_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_WINDOW_MS, 'HITLY_MCP_RATE_LIMIT_WINDOW_MS', 1),
    capabilities,
  }
}
