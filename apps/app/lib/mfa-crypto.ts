/**
 * MFA cryptography: AES-256-GCM for the TOTP secret, HMAC-SHA256 for
 * recovery codes, RFC 6238 TOTP (SHA-1, 30s, 6 digits, ±1 step).
 *
 * The wrapping key is HITLY_MFA_ENCRYPTION_KEY (32-byte standard base64).
 * Encrypt and decrypt fail closed when it is missing or not 32 bytes;
 * nothing here logs a secret, code, or key.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export const MFA_ENCRYPTION_KEY_ENV = 'HITLY_MFA_ENCRYPTION_KEY'
export const MFA_TOTP_PERIOD_SECONDS = 30
export const MFA_TOTP_DIGITS = 6
export const MFA_TOTP_WINDOW = 1
export const MFA_TOTP_SECRET_BYTES = 20
export const MFA_RECOVERY_CODE_COUNT = 10
export const MFA_TOTP_ISSUER = 'HITLy'
export const MFA_CIPHER_VERSION = 'v1'

const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function mfaEncryptionKeyProblem(value: string | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return `${MFA_ENCRYPTION_KEY_ENV} must be set`
  let key: Buffer
  try {
    key = Buffer.from(raw, 'base64')
  } catch {
    return `${MFA_ENCRYPTION_KEY_ENV} must be 32-byte standard base64`
  }
  if (key.length !== AES_KEY_BYTES) return `${MFA_ENCRYPTION_KEY_ENV} must be 32-byte standard base64`
  return null
}

export function resolveMfaEncryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  const problem = mfaEncryptionKeyProblem(env[MFA_ENCRYPTION_KEY_ENV])
  if (problem) throw new Error(`${problem}; refusing to use MFA cryptography.`)
  return Buffer.from((env[MFA_ENCRYPTION_KEY_ENV] ?? '').trim(), 'base64')
}

function deriveRecoveryKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'hitly-mfa-recovery-v1', AES_KEY_BYTES))
}

export function encryptUtf8(plaintext: string, key: Buffer): string {
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${MFA_CIPHER_VERSION}:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`
}

export function decryptUtf8(payload: string, key: Buffer): string {
  const prefix = `${MFA_CIPHER_VERSION}:`
  if (!payload.startsWith(prefix)) throw new Error('unsupported MFA ciphertext')
  const blob = Buffer.from(payload.slice(prefix.length), 'base64')
  if (blob.length <= GCM_IV_BYTES + GCM_TAG_BYTES) throw new Error('truncated MFA ciphertext')
  const iv = blob.subarray(0, GCM_IV_BYTES)
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES)
  const encrypted = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function toBase32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function fromBase32(input: string): Buffer {
  const text = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text) {
    const idx = BASE32.indexOf(char)
    if (idx < 0) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): { secret: Buffer; base32: string } {
  const secret = randomBytes(MFA_TOTP_SECRET_BYTES)
  return { secret, base32: toBase32(secret) }
}

export function buildOtpauthUri(account: string, base32Secret: string, issuer = MFA_TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(MFA_TOTP_DIGITS),
    period: String(MFA_TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

function hotp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeUInt32BE(Math.floor(step / 0x1_0000_0000), 0)
  counter.writeUInt32BE(step >>> 0, 4)
  const hmac = createHmac('sha1', secret).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)
  return String(binary % 10 ** MFA_TOTP_DIGITS).padStart(MFA_TOTP_DIGITS, '0')
}

export function totpCode(secret: Buffer, atMs: number): string {
  return hotp(secret, Math.floor(atMs / 1000 / MFA_TOTP_PERIOD_SECONDS))
}

export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / MFA_TOTP_PERIOD_SECONDS)
}

export function normaliseTotpCode(code: string): string | null {
  const digits = code.replace(/\s+/g, '')
  return /^\d{6}$/.test(digits) ? digits : null
}

/**
 * Accepts the current step and ± MFA_TOTP_WINDOW neighbours. Steps at or
 * below `lastUsedStep` are ignored so the same code cannot be replayed
 * inside its window.
 */
export function verifyTotpCode(
  secret: Buffer,
  code: string,
  atMs: number,
  lastUsedStep: number | null,
): { ok: true; step: number } | { ok: false } {
  const digits = normaliseTotpCode(code)
  if (!digits) return { ok: false }
  const current = totpStep(atMs)
  const presented = Buffer.from(digits)
  let matched: number | null = null
  for (let delta = -MFA_TOTP_WINDOW; delta <= MFA_TOTP_WINDOW; delta += 1) {
    const step = current + delta
    if (lastUsedStep !== null && step <= lastUsedStep) continue
    const expected = Buffer.from(hotp(secret, step))
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      matched = step
    }
  }
  return matched === null ? { ok: false } : { ok: true, step: matched }
}

function randomRecoveryPart(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
  return out
}

export function generateRecoveryCodes(count = MFA_RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>()
  while (codes.size < count) {
    codes.add(`${randomRecoveryPart(4)}-${randomRecoveryPart(4)}`)
  }
  return [...codes]
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function hashRecoveryCode(code: string, master: Buffer): string {
  const key = deriveRecoveryKey(master)
  return createHmac('sha256', key).update(normaliseRecoveryCode(code), 'utf8').digest('hex')
}

export function recoveryCodeLooksWellFormed(code: string): boolean {
  return /^[A-Z0-9]{8}$/.test(normaliseRecoveryCode(code))
}
