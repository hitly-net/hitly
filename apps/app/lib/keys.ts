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
 * credential (MCP marketplace connectors, e.g. Grok). Shaped like a compact
 * JWT — URL-safe characters plus the two separators. Malformed guesses are
 * refused BEFORE any per-key rate-limit counting or host round-trip, and the
 * `hitly_` prefix never matches (that space belongs to API keys, including
 * revoked/malformed ones, so they keep failing as keys, not as tokens).
 */
export function isWellFormedDelegatedToken(raw: string): boolean {
  return !raw.startsWith('hitly_') && /^[A-Za-z0-9._~+\/-]{20,512}$/.test(raw)
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
