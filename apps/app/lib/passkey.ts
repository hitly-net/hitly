/**
 * Passkeys (client-safe half): endpoint constants, fixed messages, and the
 * submit helpers the security and login pages import. The handlers that
 * touch auth, the database and WebAuthn live in lib/passkey-route.ts, so
 * client components never import the challenge store or public keys; the
 * branded passkey-added notice email lives in lib/passkey-emails.ts.
 *
 * Re-auth wording reuses CURRENT_PASSWORD_INCORRECT_MESSAGE from the
 * password-change flow; this module does not change that behaviour.
 *
 * Better Auth's passkey plugin still serves sign-in
 * (`/api/auth/passkey/generate-authenticate-options` and
 * `/passkey/verify-authentication`). Register, list, rename and delete go
 * through `/api/session/passkey/*` so adding or removing a passkey requires
 * the current password. Plugin management paths are 404 (see
 * isPasskeyPluginManagementPath).
 */

import { CURRENT_PASSWORD_INCORRECT_MESSAGE } from './password-change'
import { RESET_REQUEST_NETWORK_MESSAGE } from './password-reset'

export const PASSKEY_LIST_ENDPOINT = '/api/session/passkey'
export const PASSKEY_REGISTER_OPTIONS_ENDPOINT = '/api/session/passkey/register/options'
export const PASSKEY_REGISTER_ENDPOINT = '/api/session/passkey/register'
export const PASSKEY_AUTH_OPTIONS_ENDPOINT = '/api/auth/passkey/generate-authenticate-options'
export const PASSKEY_AUTH_VERIFY_ENDPOINT = '/api/auth/passkey/verify-authentication'

export const PASSKEY_CHALLENGE_COOKIE = 'hitly.passkey_challenge'
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000
export const PASSKEY_NAME_MAX_LENGTH = 64
export const PASSKEY_DEFAULT_NAME = 'Passkey'

export const PASSKEY_UNAUTHENTICATED_MESSAGE = 'Your session has ended. Sign in again to manage passkeys.'
export const PASSKEY_THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'
export const PASSKEY_FAILED_MESSAGE = 'Could not update passkeys. Check the details and try again.'
export const PASSKEY_RETRY_MESSAGE = 'Could not update passkeys right now. Try again in a moment.'
export const PASSKEY_ADDED_MESSAGE = 'Passkey added.'
export const PASSKEY_REMOVED_MESSAGE = 'Passkey removed.'
export const PASSKEY_RENAMED_MESSAGE = 'Passkey renamed.'
export const PASSKEY_SIGN_IN_FAILED_MESSAGE = 'Could not sign in with a passkey. Try again or use your password.'
export const PASSKEY_CANCELLED_MESSAGE = 'Passkey sign-in was cancelled.'
export const PASSKEY_UNSUPPORTED_MESSAGE = 'Passkeys are not available in this browser.'
export const PASSKEY_INVALID_NAME_MESSAGE = 'Enter a name for this passkey.'

/** WebAuthn userVerification is required so a passkey is a multi-factor credential. */
export const PASSKEY_USER_VERIFICATION = 'required' as const
const USER_VERIFIED_FLAG = 0b0000_0100

export { CURRENT_PASSWORD_INCORRECT_MESSAGE }

/**
 * Plugin HTTP paths that skip current-password re-auth. Authenticate stays
 * open (`PASSKEY_PLUGIN_AUTHENTICATE_PATHS`). Keep this list equal to every
 * stock Better Auth passkey endpoint except those two — the tests enumerate
 * `passkey().endpoints` so a new plugin path fails CI until it is blocked.
 */
export const PASSKEY_PLUGIN_MANAGEMENT_PATHS = [
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
  '/passkey/list-user-passkeys',
] as const

export const PASSKEY_PLUGIN_AUTHENTICATE_PATHS = [
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
] as const

/** Lowercase pathname with trailing slashes stripped, or null if `url` is not a URL. */
export function passkeyPluginPathname(url: string): string | null {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, '') || '/'
    return pathname.toLowerCase()
  } catch {
    return null
  }
}

function pathEndsWith(pathname: string, suffix: string): boolean {
  return pathname.endsWith(suffix.toLowerCase())
}

export function isPasskeyPluginManagementPath(url: string): boolean {
  const pathname = passkeyPluginPathname(url)
  if (!pathname) return false
  return PASSKEY_PLUGIN_MANAGEMENT_PATHS.some((path) => pathEndsWith(pathname, path))
}

export function isPasskeyPluginAuthenticatePath(url: string, suffix?: (typeof PASSKEY_PLUGIN_AUTHENTICATE_PATHS)[number]): boolean {
  const pathname = passkeyPluginPathname(url)
  if (!pathname) return false
  const suffixes = suffix ? [suffix] : PASSKEY_PLUGIN_AUTHENTICATE_PATHS
  return suffixes.some((path) => pathEndsWith(pathname, path))
}

function decodeWebAuthnBytes(value: string): Uint8Array | null {
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const binary = atob(b64 + pad)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function authenticatorDataFromAssertion(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const wrapper = body as { response?: unknown }
  const assertion = wrapper.response
  if (!assertion || typeof assertion !== 'object') return null
  const inner = assertion as { response?: { authenticatorData?: unknown }; authenticatorData?: unknown }
  const data = inner.response && typeof inner.response === 'object' ? inner.response.authenticatorData : inner.authenticatorData
  return typeof data === 'string' ? data : null
}

/** True when the assertion's authenticatorData has the UV flag set. Fail closed. */
export function assertionHasUserVerification(body: unknown): boolean {
  const data = authenticatorDataFromAssertion(body)
  if (!data) return false
  const bytes = decodeWebAuthnBytes(data)
  if (!bytes || bytes.length < 33) return false
  return (bytes[32]! & USER_VERIFIED_FLAG) !== 0
}

export function withRequiredUserVerification<T extends Record<string, unknown>>(options: T): T {
  return { ...options, userVerification: PASSKEY_USER_VERIFICATION }
}

export function passkeyItemEndpoint(id: string): string {
  return `${PASSKEY_LIST_ENDPOINT}/${encodeURIComponent(id)}`
}

export function passkeyDeleteEndpoint(id: string): string {
  return `${passkeyItemEndpoint(id)}/delete`
}

export type PasskeyListItem = {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

export type PasskeyOutcome = { ok: true } | { ok: false; message: string }
export type PasskeyRegisterOutcome =
  | { ok: true; passkey: PasskeyListItem }
  | { ok: false; message: string }
export type PasskeyRegisterOptionsOutcome =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; message: string }
export type PasskeyListOutcome = { ok: true; passkeys: PasskeyListItem[] } | { ok: false; message: string }

export function normalisePasskeyName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > PASSKEY_NAME_MAX_LENGTH) return null
  return name
}

async function readError(response: Response): Promise<{ code?: string; error?: string }> {
  return (await response.json().catch(() => ({}))) as { code?: string; error?: string }
}

function mapMutationError(response: Response, data: { code?: string; error?: string }): string {
  if (response.status === 401) return PASSKEY_UNAUTHENTICATED_MESSAGE
  if (response.status === 429) return PASSKEY_THROTTLED_MESSAGE
  if (response.status >= 500) return PASSKEY_RETRY_MESSAGE
  if (data.code === 'INVALID_PASSWORD') return CURRENT_PASSWORD_INCORRECT_MESSAGE
  if (data.code === 'INVALID_NAME' || data.error === 'invalid_name') return PASSKEY_INVALID_NAME_MESSAGE
  return PASSKEY_FAILED_MESSAGE
}

export async function submitPasskeyRegisterOptions(
  currentPassword: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeyRegisterOptionsOutcome> {
  try {
    const response = await fetchImpl(PASSKEY_REGISTER_OPTIONS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, name }),
      credentials: 'include',
    })
    if (response.ok) {
      const options = (await response.json()) as PublicKeyCredentialCreationOptionsJSON
      return { ok: true, options }
    }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitPasskeyRegister(
  responseJSON: unknown,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeyRegisterOutcome> {
  try {
    const response = await fetchImpl(PASSKEY_REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: responseJSON, name }),
      credentials: 'include',
    })
    if (response.ok) {
      const data = (await response.json()) as { passkey?: PasskeyListItem }
      if (data.passkey) return { ok: true, passkey: data.passkey }
      const id = typeof (responseJSON as { id?: unknown }).id === 'string' ? (responseJSON as { id: string }).id : ''
      return {
        ok: true,
        passkey: {
          id,
          name: name.trim() || PASSKEY_DEFAULT_NAME,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
      }
    }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitPasskeyRename(
  id: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeyOutcome> {
  try {
    const response = await fetchImpl(passkeyItemEndpoint(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

export async function submitPasskeyDelete(
  id: string,
  currentPassword: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeyOutcome> {
  try {
    const response = await fetchImpl(passkeyDeleteEndpoint(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword }),
      credentials: 'include',
    })
    if (response.ok) return { ok: true }
    return { ok: false, message: mapMutationError(response, await readError(response)) }
  } catch {
    return { ok: false, message: RESET_REQUEST_NETWORK_MESSAGE }
  }
}

/** Browser WebAuthn JSON types; kept structural so this module stays free of server imports. */
export type PublicKeyCredentialCreationOptionsJSON = {
  challenge: string
  rp: { name: string; id?: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>
  timeout?: number
  excludeCredentials?: Array<{ id: string; type: 'public-key'; transports?: string[] }>
  authenticatorSelection?: Record<string, unknown>
  attestation?: string
  extensions?: Record<string, unknown>
}

export type RegistrationResponseJSON = {
  id: string
  rawId: string
  type: 'public-key'
  response: Record<string, unknown>
  clientExtensionResults?: Record<string, unknown>
  authenticatorAttachment?: string
}
