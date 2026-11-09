/**
 * Reviewer-facing redaction for the create-once request payload (hitly#98)
 * and GET /api/v1/approvals/:id (`getApprovalDetail`).
 *
 * Applied in `getOriginalRequest` (source) and `getApprovalDetail` (origin /
 * envelope.origin and other envelope fields that can carry callback/resume
 * secrets, plus `decisions[].payload` and `resumeResponse`), and again in the
 * approval-detail UI (display, copy, download) as a second line of defence.
 * Hashes (`payloadHash`, `argsHash`) are computed over the stored original
 * *before* this runs. This module never writes back to the database.
 *
 * Strips `cb_auth_token`, resume handles, and secret-like fields. Does not
 * touch account/password logging (`lib/auth-logging.ts`).
 *
 * Key matching is segment-aware (camelCase, snake, kebab, SCREAMING) so
 * `tokenCount` / `signatureRequired` / `tokenType` / `secretly` stay visible.
 * Folding is NFKD + strip combining marks (é → e), then a small Cyrillic /
 * Greek / Armenian / schwa homoglyph map. Not the full Unicode TR39 list.
 */

export const REDACTED = '[redacted]'

/**
 * Latin lookalikes used against the keys we match. NFKD already folds
 * fullwidth A–Z and decomposes accents. Remaining scripts are a known gap.
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
  // Armenian lookalikes (skeleton subset for secret / token / cookie / …).
  '\u0585': 'o', // օ OH
  '\u0555': 'o', // Օ
  '\u057D': 's', // ս SE
  '\u054D': 's', // Ս
  '\u0570': 'h', // հ HO
  '\u0540': 'h', // Հ
  '\u0582': 'i', // ւ YIWN
  '\u0584': 'p', // ք KEH
  '\u0581': 'g', // ց CO
  '\u056D': 'x', // խ XEH
  // Schwa (Latin and Cyrillic).
  '\u0259': 'e', // ə
  '\u018F': 'e', // Ə
  '\u04D9': 'e', // ә
  '\u04D8': 'e', // Ә
}

/** NFKD + strip marks, then homoglyph map. Keeps separators and case for segmentation. */
function mappedKey(key: string): string {
  const stripped = key.normalize('NFKD').replace(/\p{M}/gu, '')
  let mapped = ''
  for (const ch of stripped) {
    mapped += HOMOGLYPHS[ch] ?? ch
  }
  return mapped
}

function foldKey(key: string): string {
  return mappedKey(key).replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

/** camelCase / PascalCase / snake / kebab / SCREAMING segments, after folding. */
function keySegments(key: string): string[] {
  const parts = mappedKey(key).split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const segs: string[] = []
  for (const part of parts) {
    const split = part
      .replace(/([a-z0-9])([A-Z])/g, '$1\0$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2')
    for (const piece of split.split('\0')) {
      if (piece) segs.push(piece.toLowerCase())
    }
  }
  return segs
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

const SECRET_SEGMENTS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'signature',
  'apikey',
  'credential',
  'credentials',
  'authorization',
  'bearer',
  'privatekey',
])

/** Last-segment allow-list: tokenCount, signatureRequired, tokenType stay visible. */
const SAFE_SUFFIXES = new Set(['count', 'required', 'type'])

/** True when this JSON key must never appear with its real value in the reviewer view. */
export function isSecretRequestKey(key: string): boolean {
  const folded = foldKey(key)
  if (!folded) return false
  if (EXACT_SECRET_KEYS.has(folded)) return true
  if (folded.includes('resumehandle')) return true
  const segs = keySegments(key)
  if (segs.length === 0) return false
  const last = segs[segs.length - 1]!
  if (SAFE_SUFFIXES.has(last)) return false
  return segs.some((seg) => SECRET_SEGMENTS.has(seg))
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
