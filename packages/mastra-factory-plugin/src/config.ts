import type { Gate, PluginRuntimeConfig } from './types.ts'
import { parseEnvFallback, type EnvFallback } from './connections.ts'

export const DEFAULT_POLL_INTERVAL_MS = 30_000

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`@hitly/mastra-factory-plugin: missing required env var ${name}`)
  return value
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return fallback
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function parseSecrets(env: Record<string, string | undefined>): string[] {
  const list = env.HITLY_WEBHOOK_SIGNING_SECRETS
  const single = env.HITLY_WEBHOOK_SIGNING_SECRET
  const source = list?.trim() ? list : single ?? ''
  const secrets = source
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (secrets.length === 0) {
    throw new Error(
      '@hitly/mastra-factory-plugin: missing required env var HITLY_WEBHOOK_SIGNING_SECRETS (or HITLY_WEBHOOK_SIGNING_SECRET)',
    )
  }
  return secrets
}

export function parseRuntimeConfig(env: Record<string, string | undefined>): PluginRuntimeConfig {
  const hitlyBaseUrl = normalizeUrl(required(env, 'HITLY_API_URL'))
  const hitlyApiKey = required(env, 'HITLY_API_KEY')
  const projectId = required(env, 'HITLY_PROJECT_ID')
  const publicBaseUrl = normalizeUrl(required(env, 'HITLY_PUBLIC_URL'))
  const webhookSigningSecrets = parseSecrets(env)

  const gates: Record<Gate, boolean> = {
    plan: parseBoolean(env.HITLY_GATE_PLAN, true),
    review: parseBoolean(env.HITLY_GATE_REVIEW, true),
    ask_user: parseBoolean(env.HITLY_GATE_ASK_USER, true),
  }

  const pollIntervalMs = parsePollIntervalMs(env)
  const githubToken = env.HITLY_GITHUB_TOKEN?.trim() || undefined

  return {
    hitlyBaseUrl,
    hitlyApiKey,
    projectId,
    publicBaseUrl,
    webhookSigningSecrets,
    gates,
    mergeAfterAccept: parseBoolean(env.HITLY_MERGE_AFTER_ACCEPT, false),
    githubToken,
    pollIntervalMs,
  }
}

function parsePollIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env.HITLY_POLL_INTERVAL_MS?.trim()
  const pollIntervalMs = raw ? Number(raw) : DEFAULT_POLL_INTERVAL_MS
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error('@hitly/mastra-factory-plugin: HITLY_POLL_INTERVAL_MS must be a number >= 1000')
  }
  return pollIntervalMs
}

/** Deployment-level parsed environment for the registry-mode entry point. */
export interface HitlyDeploymentConfig {
  /**
   * Deployment-level config. With `envFallback.mode === 'none'` the HITLy
   * credential vars are absent and this carries only deployment facts
   * (publicBaseUrl, poll interval, github token) — connections come from the
   * per-factory registry instead.
   */
  config: PluginRuntimeConfig
  envFallback: EnvFallback
}

/**
 * Parse the environment for a Factory deployment. HITLY_PUBLIC_URL is always
 * required (resume URLs are built from it); the HITLy credential vars are
 * only required when HITLY_ENV_FALLBACK opts factories into env credentials.
 */
export function parseDeploymentConfig(env: Record<string, string | undefined>): HitlyDeploymentConfig {
  const envFallback = parseEnvFallback(env.HITLY_ENV_FALLBACK)
  if (envFallback.mode !== 'none') {
    return { config: parseRuntimeConfig(env), envFallback }
  }
  // No env fallback: the HITLy credential vars are optional. A deployment
  // that only uses per-factory saved connections still needs the public
  // base URL (callbacks point back at it) and may still carry a GitHub token.
  const publicBaseUrl = normalizeUrl(required(env, 'HITLY_PUBLIC_URL'))
  return {
    envFallback,
    config: {
      hitlyBaseUrl: '',
      hitlyApiKey: '',
      projectId: '',
      publicBaseUrl,
      webhookSigningSecrets: [],
      gates: { plan: true, review: true, ask_user: true },
      mergeAfterAccept: false,
      githubToken: env.HITLY_GITHUB_TOKEN?.trim() || undefined,
      pollIntervalMs: parsePollIntervalMs(env),
    },
  }
}
