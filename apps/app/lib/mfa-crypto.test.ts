import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MFA_ENCRYPTION_KEY_ENV,
  MFA_RECOVERY_ALPHABET,
  MFA_RECOVERY_CODE_COUNT,
  MFA_TOTP_PERIOD_SECONDS,
  buildOtpauthUri,
  decryptUtf8,
  encryptUtf8,
  fromBase32,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  mfaEncryptionKeyProblem,
  normaliseRecoveryCode,
  resolveMfaEncryptionKey,
  toBase32,
  totpCode,
  totpStep,
  verifyTotpCode,
} from './mfa-crypto'

const KEY = Buffer.alloc(32, 9)

describe('MFA wrapping key', () => {
  it('fails closed when the key is missing or not 32 bytes', () => {
    assert.match(mfaEncryptionKeyProblem(undefined) ?? '', /HITLY_MFA_ENCRYPTION_KEY/)
    assert.match(mfaEncryptionKeyProblem('') ?? '', /HITLY_MFA_ENCRYPTION_KEY/)
    assert.match(mfaEncryptionKeyProblem('AAAA') ?? '', /32-byte/)
    assert.equal(mfaEncryptionKeyProblem(KEY.toString('base64')), null)
    assert.throws(() => resolveMfaEncryptionKey({}), /HITLY_MFA_ENCRYPTION_KEY/)
    assert.throws(
      () => resolveMfaEncryptionKey({ [MFA_ENCRYPTION_KEY_ENV]: 'short' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : ''
        assert.match(message, /HITLY_MFA_ENCRYPTION_KEY/)
        assert.ok(!message.includes('short'))
        return true
      },
    )
  })
})

describe('TOTP secret encryption', () => {
  it('round-trips and does not store the plaintext secret in the ciphertext', () => {
    const { secret, base32 } = generateTotpSecret()
    const ciphertext = encryptUtf8(base32, KEY)
    assert.equal(decryptUtf8(ciphertext, KEY), base32)
    assert.ok(!ciphertext.includes(base32))
    assert.ok(!ciphertext.includes(secret.toString('hex')))
    assert.match(ciphertext, /^v1:/)
    assert.deepEqual(fromBase32(toBase32(secret)), secret)
  })
})

describe('TOTP verify', () => {
  it('accepts the current step and ±1, and rejects reuse of a used step', () => {
    const { secret } = generateTotpSecret()
    const now = 1_700_000_000_000
    const current = totpCode(secret, now)
    const previous = totpCode(secret, now - MFA_TOTP_PERIOD_SECONDS * 1000)
    const next = totpCode(secret, now + MFA_TOTP_PERIOD_SECONDS * 1000)
    const far = totpCode(secret, now + MFA_TOTP_PERIOD_SECONDS * 2 * 1000)

    assert.equal(verifyTotpCode(secret, current, now, null).ok, true)
    assert.equal(verifyTotpCode(secret, previous, now, null).ok, true)
    assert.equal(verifyTotpCode(secret, next, now, null).ok, true)
    assert.equal(verifyTotpCode(secret, far, now, null).ok, false)
    assert.equal(verifyTotpCode(secret, '000000', now, null).ok, false)

    const used = totpStep(now)
    assert.equal(verifyTotpCode(secret, current, now, used).ok, false)
    assert.equal(verifyTotpCode(secret, previous, now, used).ok, false)
    assert.equal(verifyTotpCode(secret, next, now, used).ok, true)
  })

  it('builds an otpauth URI that carries the issuer and secret', () => {
    const uri = buildOtpauthUri('alex@example.com', 'MFRGGZDFMZTWQ2LK')
    assert.match(uri, /^otpauth:\/\/totp\//)
    assert.match(uri, /secret=MFRGGZDFMZTWQ2LK/)
    assert.match(uri, /issuer=HITLy/)
  })
})

describe('RFC 6238 Appendix B', () => {
  it('matches the SHA-1 6-digit truncations of the Appendix B vectors', () => {
    // Appendix B publishes 8-digit SHA-1 TOTP; HITLy uses 6 digits (mod 10^6).
    const secret = Buffer.from('12345678901234567890', 'ascii')
    const vectors: Array<[unixSeconds: number, digits: string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ]
    for (const [unixSeconds, digits] of vectors) {
      assert.equal(totpCode(secret, unixSeconds * 1000), digits, `T=${unixSeconds}`)
    }
  })
})

describe('recovery codes', () => {
  it('hashes with HMAC and never equals the plaintext', () => {
    const codes = generateRecoveryCodes(10)
    assert.equal(codes.length, 10)
    assert.equal(new Set(codes).size, 10)
    for (const code of codes) {
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      const digest = hashRecoveryCode(code, KEY)
      assert.equal(digest.length, 64)
      assert.ok(!digest.includes(code))
      assert.ok(!digest.includes(normaliseRecoveryCode(code)))
      assert.equal(hashRecoveryCode(code.toLowerCase().replace('-', ' '), KEY), digest)
    }
  })

  it('draws recovery characters with randomInt, not modulo on random bytes', () => {
    assert.equal(MFA_RECOVERY_ALPHABET.length, 32)
    const codes = generateRecoveryCodes(MFA_RECOVERY_CODE_COUNT)
    assert.equal(codes.length, MFA_RECOVERY_CODE_COUNT)
    for (const code of codes) {
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      for (const char of code.replace('-', '')) {
        assert.ok(MFA_RECOVERY_ALPHABET.includes(char), char)
      }
    }
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'mfa-crypto.ts'), 'utf8')
    const body = source.slice(source.indexOf('function randomRecoveryPart'), source.indexOf('export function generateRecoveryCodes'))
    assert.match(body, /randomInt\s*\(\s*MFA_RECOVERY_ALPHABET\.length\s*\)/)
    assert.equal(body.includes('%'), false, 'recovery characters must not use modulo on random bytes')
    assert.equal(body.includes('randomBytes'), false)
  })
})
