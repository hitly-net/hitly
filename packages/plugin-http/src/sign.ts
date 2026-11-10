import { createHmac, createHash, timingSafeEqual } from 'node:crypto'

/** Header carrying Unix-seconds timestamp for callback authenticity. */
export const HEADER_TIMESTAMP = 'x-hitly-timestamp'
/** Header carrying the unique event id (receivers MUST dedupe on it). */
export const HEADER_EVENT_ID = 'x-hitly-event-id'
/** Header carrying HMAC-SHA256 hex digest of `timestamp + "." + body`. */
export const HEADER_SIGNATURE = 'x-hitly-signature'
/** Header carrying the signing-key id (not secret). */
export const HEADER_KEY_ID = 'x-hitly-key-id'

/** Receivers SHOULD reject timestamps older than this (seconds). */
export const TIMESTAMP_MAX_SKEW_SECONDS = 5 * 60

/** Stable, non-secret key id derived from the signing secret. */
export function webhookKeyId(secret: string): string {
  const digest = createHash('sha256').update(secret, 'utf8').digest('hex')
  return `hk_${digest.slice(0, 8)}`
}

/**
 * One per-project webhook signing key. The active key signs deliveries; a
 * rotated-out key stays verifiable until `validUntil` (unix seconds) so
 * receivers have an OVERLAP WINDOW to pick up the new secret without a
 * cut-over that rejects in-flight callbacks.
 */
export interface SigningKeyEntry {
  keyId: string
  secret: string
  /** Unix seconds; null/absent = valid (until rotated out). */
  validUntil?: number | null
  /** Unix seconds this key was created (rotation picks the newest active key). */
  createdAt?: number
}

/** True when the entry's shape is usable and it is not yet rotated out. */
export function isSigningKeyUsable(entry: SigningKeyEntry, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  if (typeof entry.keyId !== 'string' || !entry.keyId.trim()) return false
  if (typeof entry.secret !== 'string' || !entry.secret.trim()) return false
  return entry.validUntil === undefined || entry.validUntil === null || entry.validUntil > nowSeconds
}

/** Newest usable key, or null when none is active. */
export function pickActiveSigningKey(
  entries: readonly SigningKeyEntry[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SigningKeyEntry | null {
  let best: SigningKeyEntry | null = null
  for (const entry of entries) {
    if (!isSigningKeyUsable(entry, nowSeconds)) continue
    if (!best || (entry.createdAt ?? 0) > (best.createdAt ?? 0)) best = entry
  }
  return best
}

/** Canonical string to sign: `<unixSeconds>.<rawBody>`. */
export function signaturePayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`
}

/** Hex-encoded HMAC-SHA256 over the canonical payload. */
export function signBody(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret).update(signaturePayload(timestampSeconds, rawBody), 'utf8').digest('hex')
}

export interface VerifyInput {
  /** Single-secret verify (legacy). Ignored when `keys` is provided. */
  secret?: string
  /**
   * Keyed verify with a rotation OVERLAP WINDOW: entries as stored on the
   * project (`webhookSigningSecrets`). A key past `validUntil` is refused;
   * within the overlap both the old and the new key verify. When the sender
   * sent `X-HITLy-Key-Id` the registry must contain it.
   */
  keys?: readonly SigningKeyEntry[]
  rawBody: string
  timestampHeader: string | null | undefined
  signatureHeader: string | null | undefined
  keyIdHeader?: string | null | undefined
  /** Override "now" for tests (unix seconds). */
  nowSeconds?: number
  maxSkewSeconds?: number
}

export type VerifyResult =
  | { ok: true; keyId: string; timestampSeconds: number }
  | { ok: false; reason: 'missing' | 'bad_timestamp' | 'skew' | 'bad_signature' | 'key_mismatch' | 'expired_key' | 'no_keys' }

/**
 * Optional receiver-side verification. Grok Bot / n8n MAY skip this and rely on
 * Bearer + get_decision; when used, reject skew > 5 minutes and bad signatures.
 */
export function verifyHttpSignature(input: VerifyInput): VerifyResult {
  const tsRaw = input.timestampHeader?.trim() ?? ''
  const sigRaw = input.signatureHeader?.trim() ?? ''
  if (!tsRaw || !sigRaw) return { ok: false, reason: 'missing' }
  if (!/^\d+$/.test(tsRaw)) return { ok: false, reason: 'bad_timestamp' }
  const timestampSeconds = Number(tsRaw)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const skew = input.maxSkewSeconds ?? TIMESTAMP_MAX_SKEW_SECONDS
  if (Math.abs(now - timestampSeconds) > skew) return { ok: false, reason: 'skew' }

  const keyId = input.keyIdHeader?.trim()

  if (input.keys) {
    const usable = input.keys.filter((entry) => isSigningKeyUsable(entry, now))
    const expired = input.keys.filter(
      (entry) => entry.validUntil !== undefined && entry.validUntil !== null && entry.validUntil <= now,
    )
    if (keyId) {
      const match = input.keys.find((entry) => entry.keyId === keyId)
      if (!match) return { ok: false, reason: 'key_mismatch' }
      if (!isSigningKeyUsable(match, now)) return { ok: false, reason: 'expired_key' }
      return matches(match.secret) ? { ok: true, keyId: match.keyId, timestampSeconds } : { ok: false, reason: 'bad_signature' }
    }
    // No key id sent (legacy senders): accept against any usable key; if only
    // expired keys match, report the expiry rather than a bare bad_signature.
    if (usable.some((entry) => matches(entry.secret))) {
      const winner = usable.find((entry) => matches(entry.secret))!
      return { ok: true, keyId: winner.keyId, timestampSeconds }
    }
    if (expired.some((entry) => matches(entry.secret))) return { ok: false, reason: 'expired_key' }
    return { ok: false, reason: usable.length === 0 ? 'no_keys' : 'bad_signature' }
  }

  if (typeof input.secret !== 'string' || !input.secret.trim()) return { ok: false, reason: 'no_keys' }
  const expectedKeyId = webhookKeyId(input.secret)
  if (keyId && keyId !== expectedKeyId) return { ok: false, reason: 'key_mismatch' }
  if (!matches(input.secret)) return { ok: false, reason: 'bad_signature' }
  return { ok: true, keyId: expectedKeyId, timestampSeconds }

  function matches(secret: string): boolean {
    const expected = signBody(secret, timestampSeconds, input.rawBody)
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(sigRaw, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }
}

/** Build the four HITLy callback auth/signature headers. */
export function buildSignatureHeaders(args: {
  secret: string
  eventId: string
  rawBody: string
  timestampSeconds?: number
  /** Stored key id to advertise (defaults to the derived `hk_...` id). */
  keyId?: string
}): Record<string, string> {
  const timestampSeconds = args.timestampSeconds ?? Math.floor(Date.now() / 1000)
  return {
    [HEADER_TIMESTAMP]: String(timestampSeconds),
    [HEADER_EVENT_ID]: args.eventId,
    [HEADER_KEY_ID]: args.keyId?.trim() ? args.keyId.trim() : webhookKeyId(args.secret),
    [HEADER_SIGNATURE]: signBody(args.secret, timestampSeconds, args.rawBody),
  }
}
