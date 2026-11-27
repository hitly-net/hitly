import { createHash, randomBytes } from 'node:crypto'

export function hashApiKey(raw: string) {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Cheap shape check for a presented API key (generateApiKey's format:
 * `hitly_` + 32 base64url characters). Used to reject junk BEFORE any
 * per-key rate-limit counting, so guesses never create per-key rows.
 */
export function isWellFormedApiKey(raw: string): boolean {
  return /^hitly_[A-Za-z0-9_-]{32}$/.test(raw)
}

/**
 * Cheap shape check for a delegated OAuth access token presented as a bearer
 * credential (MCP marketplace connectors, e.g. Grok). Delegated tokens are
 * compact HS256 JWTs — three non-empty base64url segments separated by dots.
 * The full JWT shape is the point: bearer SESSION tokens (Better Auth session
 * ids contain no dots) must NOT pass this check, so they fall through to the
 * session check instead of being classified — and possibly budget-counted —
 * as key attempts. Malformed guesses are refused BEFORE any per-key
 * rate-limit counting or host round-trip, and the `hitly_` prefix never
 * matches (that space belongs to API keys, including revoked/malformed ones,
 * so they keep failing as keys, not as tokens).
 */
export const DELEGATED_TOKEN_MAX_LENGTH = 1024

export function isWellFormedDelegatedToken(raw: string): boolean {
  if (raw.startsWith('hitly_') || raw.length < 20 || raw.length > DELEGATED_TOKEN_MAX_LENGTH) return false
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)
}

/**
 * Any bearer credential the API accepts: a project API key, or — when the
 * Cloud edition installs the delegated-token resolver — an OAuth access
 * token. Routes gate on this before touching rate-limit state.
 */
export function isWellFormedBearer(raw: string): boolean {
  return isWellFormedApiKey(raw) || isWellFormedDelegatedToken(raw)
}

export function generateApiKey() {
  const raw = `hitly_${randomBytes(24).toString('base64url')}`
  return {
    raw,
    hashed: hashApiKey(raw),
    prefix: raw.slice(0, 12),
  }
}

export function generateResumeSecret() {
  return `hitly_resume_${randomBytes(24).toString('base64url')}`
}

export function resumeSecretPrefix(secret: string) {
  return secret.slice(0, 16)
}
