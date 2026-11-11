export const HITLY_TELEMETRY_ENV = 'HITLY_TELEMETRY'
export const PLAUSIBLE_DOMAIN_ENV = 'NEXT_PUBLIC_PLAUSIBLE_DOMAIN'
export const PLAUSIBLE_SRC_ENV = 'NEXT_PUBLIC_PLAUSIBLE_SRC'

export type TelemetryEnv = {
  HITLY_TELEMETRY?: string
  NEXT_PUBLIC_PLAUSIBLE_DOMAIN?: string
  NEXT_PUBLIC_PLAUSIBLE_SRC?: string
  NEXT_TELEMETRY_DISABLED?: string
  TURBO_TELEMETRY_DISABLED?: string
  [key: string]: string | undefined
}

/**
 * Marketing-site Plausible switch. Unset / anything other than trimmed `1` or
 * `true` is off. Does not control Next.js or Turbo CLI telemetry.
 */
export function isHitlyTelemetryEnabled(env: TelemetryEnv = process.env): boolean {
  const value = env[HITLY_TELEMETRY_ENV]?.trim()
  return value === '1' || value === 'true'
}

/** Always disable Next.js and Turbo CLI telemetry, whatever HITLY_TELEMETRY says. */
export function applyCliTelemetryDisabled(env: TelemetryEnv = process.env): void {
  env.NEXT_TELEMETRY_DISABLED = '1'
  env.TURBO_TELEMETRY_DISABLED = '1'
}

export type PlausibleScript = {
  src: string
  domain: string
}

/**
 * Marketing-site Plausible snippet. Off unless HITLY_TELEMETRY is 1 or true
 * and both domain and src are set. No hardcoded defaults (hitly.net values are
 * an example in .env.example only). Inbox (`apps/app`) never loads this.
 */
export function plausibleScript(env: TelemetryEnv = process.env): PlausibleScript | null {
  if (!isHitlyTelemetryEnabled(env)) return null
  const domain = env[PLAUSIBLE_DOMAIN_ENV]?.trim()
  const src = env[PLAUSIBLE_SRC_ENV]?.trim()
  if (!domain || !src) return null
  return { src, domain }
}
