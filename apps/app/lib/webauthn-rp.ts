/**
 * WebAuthn relying-party id and origin. Both come from the app's public
 * base URL (`BETTER_AUTH_URL`), never from a hardcoded hostname.
 *
 * Optional `HITLY_WEBAUTHN_RP_NAME` is a display name only (not a host).
 */

const DEFAULT_APP_URL = 'http://localhost:3001'

export type WebAuthnRelyingParty = {
  rpID: string
  origin: string
  rpName: string
}

export function webAuthnAppUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.BETTER_AUTH_URL ?? '').trim()
  return configured || DEFAULT_APP_URL
}

export function webAuthnRelyingParty(env: Record<string, string | undefined> = process.env): WebAuthnRelyingParty {
  const appUrl = webAuthnAppUrl(env)
  const url = new URL(appUrl)
  const rpName = (env.HITLY_WEBAUTHN_RP_NAME ?? '').trim() || 'HITLy'
  return {
    rpID: url.hostname,
    origin: url.origin,
    rpName,
  }
}
