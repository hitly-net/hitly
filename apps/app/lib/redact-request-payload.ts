/**
 * Reviewer-facing redaction for the create-once request payload (hitly#98)
 * and GET /api/v1/approvals/:id (`getApprovalDetail`).
 *
 * Applied in `getOriginalRequest` (source) and `getApprovalDetail` (origin /
 * envelope.origin and other envelope fields that can carry callback/resume
 * secrets), and again in the approval-detail UI (display, copy, download) as a
 * second line of defence. Hashes (`payloadHash`, `argsHash`) are computed over
 * the stored original *before* this runs. This module never writes back to the
 * database.
 *
 * Strips `cb_auth_token`, resume handles, and secret-like fields. Does not
 * touch account/password logging (`lib/auth-logging.ts`).
 */

export const REDACTED = '[redacted]'

/**
 * Common Latin lookalikes (Cyrillic / Greek). NFKC already folds fullwidth
 * A–Z. Not the Unicode TR39 confusable list — remaining scripts are a known gap.
 */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a',
  А: 'a',
  е: 'e',
  Е: 'e',
  о: 'o',
  О: 'o',
  р: 'p',
  Р: 'p',
  с: 'c',
  С: 'c',
  у: 'y',
  У: 'y',
  х: 'x',
  Х: 'x',
  к: 'k',
  К: 'k',
  і: 'i',
  І: 'i',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ѵ: 'v',
  ɡ: 'g',
  ӏ: 'l',
  ј: 'j',
  һ: 'h',
  α: 'a',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'y',
  χ: 'x',
  κ: 'k',
  ν: 'v',
  ι: 'i',
  η: 'n',
  ε: 'e',
}

function foldKey(key: string): string {
  const nfkc = key.normalize('NFKC')
  let mapped = ''
  for (const ch of nfkc) {
    mapped += HOMOGLYPHS[ch] ?? ch
  }
  return mapped.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
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
  'secretkey',
  'tokenvalue',
  'cookie',
  'setcookie',
  'signature',
])

/** True when this JSON key must never appear with its real value in the reviewer view. */
export function isSecretRequestKey(key: string): boolean {
  const folded = foldKey(key)
  if (!folded) return false
  if (EXACT_SECRET_KEYS.has(folded)) return true
  if (folded.includes('resumehandle')) return true
  // tokenValue, *token; secretKey, AWS_SECRET_ACCESS_KEY, *_SECRET_*; cookie / set-cookie; signature
  if (folded.includes('token')) return true
  if (folded.includes('secret')) return true
  if (folded.includes('password') || folded.includes('passwd')) return true
  if (folded.includes('cookie')) return true
  if (folded.includes('signature')) return true
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
