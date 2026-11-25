import type { PluginRuntimeConfig } from './types.ts'

export const DEFAULT_POLL_INTERVAL_MS = 30_000

export function parseRuntimeConfig(_env: Record<string, string | undefined>): PluginRuntimeConfig {
  throw new Error('not implemented')
}
