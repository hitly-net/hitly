/**
 * Account MFA (client-safe half): endpoint constants, fixed messages, and
 * the submit helpers the security and login pages import. The handlers that
 * touch auth, the database and cryptography live in lib/mfa-route.ts so
 * client components never import the encryption key or TOTP secret.
 *
 * Re-auth wording reuses CURRENT_PASSWORD_INCORRECT_MESSAGE from the
 * password-change flow; this module does not change that behaviour.
 * Disable and recovery-code regenerate also send a TOTP or recovery code.
 */

import { CURRENT_PASSWORD_INCORRECT_MESSAGE } from './password-change'
import { RESET_REQUEST_NETWORK_MESSAGE } from './password-reset'

export const MFA_STATUS_ENDPOINT = '/api/session/mfa'
export const MFA_ENROL_ENDPOINT = '/api/session/mfa/enrol'
export const MFA_CONFIRM_ENDPOINT = '/api/session/mfa/confirm'
export const MFA_DISABLE_ENDPOINT = '/api/session/mfa/disable'
export const MFA_RECOVERY_CODES_ENDPOINT = '/api/session/mfa/recovery-codes'
export const MFA_VERIFY_ENDPOINT = '/api/session/mfa/verify'
export const MFA_VERIFY_PAGE = '/login/mfa'
export const MFA_CHALLENGE_COOKIE = 'hitly.mfa_challenge'
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000

export const MFA_UNAUTHENTICATED_MESSAGE = 'Your session has ended. Sign in again to manage MFA.'
export const MFA_THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'
export const MFA_FAILED_MESSAGE = 'Could not update MFA. Check the details and try again.'
export const MFA_RETRY_MESSAGE = 'Could not update MFA right now. Try again in a moment.'
export const MFA_ALREADY_ENABLED_MESSAGE = 'Authenticator app MFA is already enabled.'
export const MFA_NOT_PENDING_MESSAGE = 'Start MFA enrolment before confirming a code.'
export const MFA_INVALID_CODE_MESSAGE = 'That code is not valid.'
export const MFA_CHALLENGE_REQUIRED_MESSAGE = 'Enter the code from your authenticator app or a recovery code to finish signing in.'
export const MFA_FACTOR_FIELD_PLACEHOLDER = 'Authenticator or recovery code'
export const MFA_VERIFY_FAILED_MESSAGE = 'Could not verify the code. Check it and try again.'
export const MFA_ENROL_SUCCEEDED_MESSAGE = 'Authenticator app MFA is now enabled. Store your recovery codes somewhere safe.'
export const MFA_DISABLED_MESSAGE = 'Authenticator app MFA has been turned off.'
export const MFA_RECOVERY_REGENERATED_MESSAGE = 'New recovery codes were created. Previous unused codes no longer work.'
export const MFA_KEY_UNAVAILABLE_MESSAGE = 'MFA is not available on this server.'

export { CURRENT_PASSWORD_INCORRECT_MESSAGE }

export type MfaStatus = {
  enabled: boolean
  pending: boolean
  recoveryCodesRemaining: number
}

export type MfaEnrolResult = {
  otpauthUri: string
  qrSvg: string
  secret: string
  recoveryCodes: string[]
}

export type MfaOutcome = { ok: true } | { ok: false; message: string }
export type MfaEnrolOutcome = { ok: true; enrol: MfaEnrolResult } | { ok: false; message: string }
export type MfaRecoveryOutcome = { ok: true; recoveryCodes: string[] } | { ok: false; message: string }

async function readError(response: Response): Promise<{ code?: string; error?: string }> {
  return (await response.json().catch(() => ({}))) as { code?: string; error?: string }
}

function mapMutationError(response: Response, data: { code?: string; error?: string }): string {
  if (response.status === 401) return MFA_UNAUTHENTICATED_MESSAGE
  if (response.status === 429) return MFA_THROTTLED_MESSAGE
  if (response.status >= 500) {
    if (data.error === 'mfa_unavailable') return MFA_KEY_UNAVAILABLE_MESSAGE
    return MFA_RETRY_MESSAGE
  }
  if (data.code === 'INVALID_PASSWORD') return CURRENT_PASSWORD_INCORRECT_MESSAGE
  if (data.error === 'already_enabled') return MFA_ALREADY_ENABLED_MESSAGE
  if (data.error === 'not_pending') return MFA_NOT_PENDING_MESSAGE
  if (data.error === 'invalid_code') return MFA_INVALID_CODE_MESSAGE
  return MFA_FAILED_MESSAGE
}

export async function submitMfaEnrol(
  currentPassword: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MfaEnrolOutcome> {
  try {
    const response = await fetchImpl(MFA_ENROL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword }),
      credentials: 'include',
    })
    if (response.ok) {
      const data = (await response.json()) as MfaEnrolResult
      return { ok: true, enrol: data }
    }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitMfaConfirm(code: string, fetchImpl: typeof fetch = fetch): Promise<MfaOutcome> {
  try {
    const response = await fetchImpl(MFA_CONFIRM_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitMfaDisable(
  currentPassword: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MfaOutcome> {
  try {
    const response = await fetchImpl(MFA_DISABLE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, code }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitMfaRecoveryCodes(
  currentPassword: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MfaRecoveryOutcome> {
  try {
    const response = await fetchImpl(MFA_RECOVERY_CODES_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, code }),
      credentials: 'include',
    })
    if (response.ok) {
      const data = (await response.json()) as { recoveryCodes?: string[] }
      return { ok: true, recoveryCodes: data.recoveryCodes ?? [] }
    }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitMfaVerify(code: string, fetchImpl: typeof fetch = fetch): Promise<MfaOutcome> {
  try {
    const response = await fetchImpl(MFA_VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, message: MFA_CHALLENGE_REQUIRED_MESSAGE }
    if (response.status === 429) return { ok: false, message: MFA_THROTTLED_MESSAGE }
    if (response.status >= 500) return { ok: false, message: MFA_RETRY_MESSAGE }
    const data = await readError(response)
    if (data.error === 'invalid_code') return { ok: false, message: MFA_INVALID_CODE_MESSAGE }
    return { ok: false, message: MFA_VERIFY_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}
