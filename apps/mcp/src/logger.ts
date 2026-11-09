import { createHash } from 'node:crypto'

/**
 * No-payload logging. A log entry can only carry these fields; anything else is
 * dropped at the type level and again at runtime. Never pass question, context, args,
 * reason, answer, response, callback URLs, tokens or host error text.
 */
export interface LogEntry {
  event: 'tool' | 'http' | 'listen' | 'auth' | 'rate_limit'
  tool?: string
  requestId?: string
  status?: string | number
  latencyMs?: number
  clientId?: string
  port?: number
}

const ALLOWED = new Set(['event', 'tool', 'requestId', 'status', 'latencyMs', 'clientId', 'port'])
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type LogSink = (line: string) => void

export interface Logger {
  log(entry: LogEntry): void
}

export function createLogger(sink: LogSink = (line) => process.stdout.write(`${line}\n`)): Logger {
  return {
    log(entry) {
      const out: Record<string, unknown> = { ts: new Date().toISOString() }
      for (const [key, value] of Object.entries(entry)) {
        if (!ALLOWED.has(key) || value === undefined) continue
        if (key === 'requestId' && (typeof value !== 'string' || !ID_PATTERN.test(value))) continue
        if (key === 'status' && typeof value === 'string' && !ID_PATTERN.test(value)) continue
        out[key] = value
      }
      sink(JSON.stringify(out))
    },
  }
}

/** Stable, non-reversible id for an API key, safe to log. */
export function clientIdFor(apiKey: string) {
  return `key_${createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 12)}`
}
