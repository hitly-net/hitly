import { createHash, randomBytes } from 'node:crypto'

export function hashApiKey(raw: string) {
  return createHash('sha256').update(raw).digest('hex')
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
