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

/** Canonical string to sign: `<unixSeconds>.<rawBody>`. */
export function signaturePayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`
}

/** Hex-encoded HMAC-SHA256 over the canonical payload. */
export function signBody(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret).update(signaturePayload(timestampSeconds, rawBody), 'utf8').digest('hex')
}

export interface VerifyInput {
  secret: string
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
  | { ok: false; reason: 'missing' | 'bad_timestamp' | 'skew' | 'bad_signature' | 'key_mismatch' }

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

  const expectedKeyId = webhookKeyId(input.secret)
  const keyId = input.keyIdHeader?.trim()
  if (keyId && keyId !== expectedKeyId) return { ok: false, reason: 'key_mismatch' }

  const expected = signBody(input.secret, timestampSeconds, input.rawBody)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(sigRaw, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' }
  return { ok: true, keyId: expectedKeyId, timestampSeconds }
}

/** Build the four HITLy callback auth/signature headers. */
export function buildSignatureHeaders(args: {
  secret: string
  eventId: string
  rawBody: string
  timestampSeconds?: number
}): Record<string, string> {
  const timestampSeconds = args.timestampSeconds ?? Math.floor(Date.now() / 1000)
  return {
    [HEADER_TIMESTAMP]: String(timestampSeconds),
    [HEADER_EVENT_ID]: args.eventId,
    [HEADER_KEY_ID]: webhookKeyId(args.secret),
    [HEADER_SIGNATURE]: signBody(args.secret, timestampSeconds, args.rawBody),
  }
}
