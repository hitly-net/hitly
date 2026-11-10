/** Resume-handle key that holds the optional per-request Bearer token. */
export const CB_AUTH_TOKEN_KEY = 'cbAuthToken'

/** Keys that must never appear in API projections, resumeData echoes, or logs. */
export const SECRET_HANDLE_KEYS = new Set([
  CB_AUTH_TOKEN_KEY,
  'cb_auth_token',
  'authorization',
  'authHeader',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

/** Drop secret fields from a resumeHandle (or any bag) for safe echo/log. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T
  }
  const record = asRecord(value)
  if (!record) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (SECRET_HANDLE_KEYS.has(key)) continue
    if (key.toLowerCase() === 'authorization') continue
    out[key] = redactSecrets(child)
  }
  return out as T
}

/** True when a serialized blob still contains a candidate secret value. */
export function containsSecretValue(haystack: unknown, secret: string): boolean {
  if (!secret) return false
  const raw = typeof haystack === 'string' ? haystack : JSON.stringify(haystack)
  return raw.includes(secret)
}

export function readCbAuthToken(resumeHandle: Record<string, unknown>): string | undefined {
  const direct = resumeHandle[CB_AUTH_TOKEN_KEY]
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const snake = resumeHandle.cb_auth_token
  if (typeof snake === 'string' && snake.trim()) return snake.trim()
  return undefined
}
