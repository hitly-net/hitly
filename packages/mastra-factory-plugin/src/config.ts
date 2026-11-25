import type { Gate, PluginRuntimeConfig } from './types.ts'

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
  const list = env.HITLY_RESUME_SECRETS
  const single = env.HITLY_RESUME_SECRET
  const source = list?.trim() ? list : single ?? ''
  const secrets = source
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (secrets.length === 0) {
    throw new Error(
      '@hitly/mastra-factory-plugin: missing required env var HITLY_RESUME_SECRETS (or HITLY_RESUME_SECRET)',
    )
  }
  return secrets
}

export function parseRuntimeConfig(env: Record<string, string | undefined>): PluginRuntimeConfig {
  const hitlyBaseUrl = normalizeUrl(required(env, 'HITLY_API_URL'))
  const hitlyApiKey = required(env, 'HITLY_API_KEY')
  const projectId = required(env, 'HITLY_PROJECT_ID')
  const publicBaseUrl = normalizeUrl(required(env, 'HITLY_PUBLIC_URL'))
  const callbackBearer = required(env, 'HITLY_CALLBACK_BEARER')
  const resumeSecrets = parseSecrets(env)

  const gates: Record<Gate, boolean> = {
    plan: parseBoolean(env.HITLY_GATE_PLAN, true),
    review: parseBoolean(env.HITLY_GATE_REVIEW, true),
    ask_user: parseBoolean(env.HITLY_GATE_ASK_USER, true),
  }

  const pollIntervalMsRaw = env.HITLY_POLL_INTERVAL_MS?.trim()
  const pollIntervalMs = pollIntervalMsRaw ? Number(pollIntervalMsRaw) : DEFAULT_POLL_INTERVAL_MS
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error('@hitly/mastra-factory-plugin: HITLY_POLL_INTERVAL_MS must be a number >= 1000')
  }

  const githubToken = env.HITLY_GITHUB_TOKEN?.trim() || undefined

  return {
    hitlyBaseUrl,
    hitlyApiKey,
    projectId,
    publicBaseUrl,
    callbackBearer,
    resumeSecrets,
    gates,
    mergeAfterAccept: parseBoolean(env.HITLY_MERGE_AFTER_ACCEPT, false),
    githubToken,
    pollIntervalMs,
  }
}
