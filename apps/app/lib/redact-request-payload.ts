/**
 * Reviewer-facing redaction for the create-once request payload (hitly#98).
 *
 * Applied in `getOriginalRequest` (source) and again in the approval-detail UI
 * (display, copy, download) as a second line of defence. Hashes (`payloadHash`,
 * `argsHash`) are computed over the stored original *before* this runs.
 *
 * Strips `cb_auth_token`, resume handles, and secret-like fields. Does not
 * touch account/password logging (`lib/auth-logging.ts`).
 */

export const REDACTED = '[redacted]'

function foldKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

const EXACT_SECRET_KEYS = new Set([
  'cbauthtoken',
  'resumehandle',
  'resumeurl',
  'resumetoken',
  'reviewtoken',
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'credential',
  'credentials',
  'privatekey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'bearer',
  'resumesecret',
])

/** True when this JSON key must never appear with its real value in the reviewer view. */
export function isSecretRequestKey(key: string): boolean {
  const folded = foldKey(key)
  if (EXACT_SECRET_KEYS.has(folded)) return true
  if (folded.includes('resumehandle')) return true
  if (folded.endsWith('token') || folded.endsWith('secret') || folded.endsWith('password') || folded.endsWith('passwd')) {
    return true
  }
  if (folded.includes('apikey') || folded.includes('privatekey') || folded.includes('credential')) return true
  return false
}

/** Deep-clone `value`, replacing secret-like fields with `[redacted]`. Idempotent. */
export function redactRequestPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRequestPayload)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretRequestKey(key) ? REDACTED : redactRequestPayload(child)
    }
    return out
  }
  return value
}

/** Pretty-printed JSON of a redacted payload (display / copy / download). */
export function redactedRequestJson(value: unknown): string {
  return JSON.stringify(redactRequestPayload(value), null, 2)
}

/** Pretty-print + redact a canonical JSON string from the original-request read. */
export function redactedRequestJsonFromCanonical(canonicalPayload: string): string {
  try {
    return redactedRequestJson(JSON.parse(canonicalPayload) as unknown)
  } catch {
    return canonicalPayload
  }
}
