/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) and the hitl-spec hash form
 * `b64url(SHA-256(JCS(value)))` used for `argsHash` (hitl-spec 3.8) and the
 * event hash chain (hitl-spec 5.4).
 *
 * - Object members are sorted by their names as UTF-16 code units (RFC 8785
 *   3.2.3), which is JavaScript's default string order.
 * - Numbers use the ECMAScript Number-to-String form (RFC 8785 3.2.2.3), which
 *   is what `JSON.stringify` produces for finite numbers; `-0` becomes `0`.
 *   Non-finite numbers are not JSON and are refused.
 * - Strings use the ECMAScript JSON string escaping (RFC 8785 3.2.2.2). Lone
 *   surrogates are not valid I-JSON (RFC 7493) and are refused.
 * - `undefined`, functions, symbols and bigints are refused rather than
 *   silently dropped, so a hash never covers less than the caller passed.
 *   `toJSON` is honoured only for `Date` (ISO string), matching JSON.stringify.
 *
 * Note: HITLy's own evidence chain (`hitly.evidence.v1`) keeps its existing
 * hex `canonicalJson` hashes so stored receipts stay verifiable; JCS is used
 * wherever the hitl-spec wire form is produced.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function fail(path: string, message: string): never {
  throw new TypeError(`JCS: ${message} at ${path || '$'}`)
}

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) fail(path, 'lone surrogate in string')
  return JSON.stringify(value)
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) fail(path, 'non-finite number')
      return JSON.stringify(value)
    case 'string':
      return serializeString(value, path)
    case 'object':
      break
    default:
      fail(path, `unsupported ${typeof value}`)
  }
  const obj = value as object
  if (obj instanceof Date) return serializeString(obj.toISOString(), path)
  if (seen.has(obj)) fail(path, 'cycle')
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item, index) => serialize(item, `${path}[${index}]`, seen)).join(',')}]`
    }
    const record = obj as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const members: string[] = []
    for (const key of keys) {
      members.push(`${serializeString(key, path)}:${serialize(record[key], `${path}.${key}`, seen)}`)
    }
    return `{${members.join(',')}}`
  } finally {
    seen.delete(obj)
  }
}

/** RFC 8785 canonical JSON text for `value`. Throws on values JSON cannot carry. */
export function jcs(value: unknown): string {
  return serialize(value, '', new Set())
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const b64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** b64url (no padding) SHA-256 of the UTF-8 bytes of `input`. */
export async function sha256B64url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
  }
  const { createHash } = await import('node:crypto')
  return bytesToB64url(new Uint8Array(createHash('sha256').update(data).digest()))
}

/** hitl-spec hash form: `b64url(SHA-256(JCS(value)))`. */
export async function jcsHash(value: unknown): Promise<string> {
  return sha256B64url(jcs(value))
}

/** hitl-spec 3.8 `action.argsHash` over the exact action arguments. */
export async function argsHash(args: Record<string, unknown>): Promise<string> {
  return jcsHash(args)
}

/** hitl-spec 5.4 event `hash`: JCS hash of the event with its `hash` member removed. */
export async function eventHash(event: Record<string, unknown>): Promise<string> {
  const { hash: _omit, ...rest } = event
  void _omit
  return jcsHash(rest)
}
