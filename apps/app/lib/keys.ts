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
