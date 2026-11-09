import { createHash } from 'node:crypto'

/**
 * RFC 8785 JSON Canonicalization Scheme for JSON values produced by JSON.parse:
 * object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and
 * string serialisation (which JSON.stringify already follows).
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`).join(',')}}`
  }
  throw new Error(`JCS: unsupported type ${typeof value}`)
}

/** hitl-spec 3.8: argsHash = b64url(SHA-256(JCS(args))). */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(jcs(args), 'utf8').digest('base64url')
}
