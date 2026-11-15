/**
 * Account deletion — the client-safe half: endpoint constants, the fixed
 * messages the confirmation page renders, the preview/export shapes the page
 * displays, and the submit helpers the form calls.
 *
 * Nothing here may import auth, the database or the mailer; the handlers live
 * in lib/account-deletion-route.ts and the decision rules in
 * lib/account-deletion-plan.ts.
 */

/**
 * The word the confirmation field must contain, exactly, before anything is
 * destroyed. Defined here (and imported by the decision core) so the client
 * bundle never pulls in the node-only parts of lib/account-deletion-plan.ts.
 */
export const DELETION_CONFIRMATION_WORD = 'DELETE' as const

export const DELETION_PREVIEW_ENDPOINT = '/api/session/delete-account/preview'
export const DELETION_EXPORT_ENDPOINT = '/api/session/export'
export const DELETION_REAUTH_OPTIONS_ENDPOINT = '/api/session/delete-account/reauth/options'
export const DELETION_REAUTH_ENDPOINT = '/api/session/delete-account/reauth'
export const DELETION_ENDPOINT = '/api/session/delete-account'

export const DELETION_CHALLENGE_COOKIE = 'hitly.deletion_challenge'
export const DELETION_CHALLENGE_TTL_MS = 5 * 60 * 1000
export const DELETION_TICKET_TTL_MS = 5 * 60 * 1000

/**
 * Better Auth's own `POST /delete-user` would drop the `users` row and let the
 * FK cascades run with none of the account-deletion rules applied (no re-auth,
 * no typed confirmation, no workspace rulings, no anonymisation, no notice).
 * The catch-all 404s these paths so `/api/session/delete-account` is the only
 * way an account can be deleted — the same mechanism that blocks the stock
 * passkey plugin management paths.
 */
export const RAW_ACCOUNT_DELETE_PATHS = ['/delete-user', '/delete-user/callback'] as const

/** Lowercase pathname with trailing slashes stripped, or null when `url` is not a URL. */
function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/'
  } catch {
    return null
  }
}

export function isRawAccountDeletePath(url: string): boolean {
  const pathname = pathnameOf(url)
  if (!pathname) return false
  const lower = pathname.toLowerCase()
  return RAW_ACCOUNT_DELETE_PATHS.some((path) => lower === path.toLowerCase() || lower.endsWith(path.toLowerCase()))
}

export const DELETION_UNAUTHENTICATED_MESSAGE = 'Your session has ended. Sign in again to delete your account.'
export const DELETION_THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'
export const DELETION_FAILED_MESSAGE = 'Could not delete your account. Check the details and try again.'
export const DELETION_RETRY_MESSAGE = 'Could not delete your account right now. Try again in a moment.'
export const DELETION_CONFIRMATION_REQUIRED_MESSAGE = `Type ${DELETION_CONFIRMATION_WORD} exactly to confirm.`
export const DELETION_REAUTH_REQUIRED_MESSAGE = 'Confirm your password or a passkey first, then try again.'
export const DELETION_SUCCEEDED_MESSAGE = 'Your account has been deleted. This is permanent.'
export const DELETION_EXPORT_FAILED_MESSAGE = 'Could not prepare your export. Try again in a moment.'
export const DELETION_PREVIEW_FAILED_MESSAGE = 'Could not load what will be deleted. Try again.'

/** What the confirmation step renders before anything is destroyed. */
export type DeletionPreview = {
  deletableWorkspaces: Array<{
    id: string
    name: string
    projects: number
    apiKeys: number
    decisions: number
  }>
  keptWorkspaces: Array<{ id: string; name: string; role: string; apiKeys: number }>
  blockedWorkspaces: Array<{ id: string; name: string; reason: string; message: string }>
  hasBlocker: boolean
  exportAvailable: boolean
}

export type DeletionOutcome = { ok: true; alreadyDeleted?: boolean } | { ok: false; message: string }

async function readErrorCode(response: Response): Promise<{ code?: string; error?: string }> {
  return (await response.json().catch(() => ({}))) as { code?: string; error?: string }
}

/**
 * Reads the preview for the confirmation step. A lost session always reads as
 * "sign in again"; nothing is disclosed for a failure.
 */
export async function submitDeletionPreview(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; preview: DeletionPreview } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(DELETION_PREVIEW_ENDPOINT, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.ok) return { ok: true, preview: (await response.json()) as DeletionPreview }
    if (response.status === 401) return { ok: false, message: DELETION_UNAUTHENTICATED_MESSAGE }
    if (response.status === 429) return { ok: false, message: DELETION_THROTTLED_MESSAGE }
    if (response.status >= 500) return { ok: false, message: DELETION_RETRY_MESSAGE }
    return { ok: false, message: DELETION_PREVIEW_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: DELETION_RETRY_MESSAGE }
  }
}

/**
 * Downloads the account export (the "export first" step the confirmation page
 * offers before anything is deleted). The server answers with an attachment;
 * the browser saves it.
 */
export async function submitAccountExport(fetchImpl: typeof fetch = fetch): Promise<DeletionOutcome> {
  try {
    const response = await fetchImpl(DELETION_EXPORT_ENDPOINT, { method: 'GET', credentials: 'include' })
    if (response.ok) {
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'hitly-account-export.json'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      return { ok: true }
    }
    if (response.status === 401) return { ok: false, message: DELETION_UNAUTHENTICATED_MESSAGE }
    return { ok: false, message: DELETION_EXPORT_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: DELETION_EXPORT_FAILED_MESSAGE }
  }
}

export type DeletionReauthMethod = 'password' | 'passkey'

export type DeletionReauthOutcome = { ok: true; ticket: string } | { ok: false; message: string }

/** Password re-auth (the passkey path is driven by components/delete-account-form.tsx). */
export async function submitDeletionPasswordReauth(
  currentPassword: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeletionReauthOutcome> {
  try {
    const response = await fetchImpl(DELETION_REAUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'password', currentPassword }),
      credentials: 'include',
    })
    if (response.ok) {
      const data = (await response.json()) as { ticket?: string }
      if (typeof data.ticket === 'string' && data.ticket) return { ok: true, ticket: data.ticket }
      return { ok: false, message: DELETION_FAILED_MESSAGE }
    }
    if (response.status === 401) return { ok: false, message: DELETION_UNAUTHENTICATED_MESSAGE }
    if (response.status === 429) return { ok: false, message: DELETION_THROTTLED_MESSAGE }
    if (response.status >= 500) return { ok: false, message: DELETION_RETRY_MESSAGE }
    const data = await readErrorCode(response)
    if (data.code === 'INVALID_PASSWORD') return { ok: false, message: 'That password is not correct.' }
    return { ok: false, message: DELETION_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: DELETION_RETRY_MESSAGE }
  }
}

export async function submitDeletionAssertionOptions(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; options: Record<string, unknown> } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(DELETION_REAUTH_OPTIONS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'include',
    })
    if (response.ok) return { ok: true, options: (await response.json()) as Record<string, unknown> }
    if (response.status === 401) return { ok: false, message: DELETION_UNAUTHENTICATED_MESSAGE }
    const data = await readErrorCode(response)
    if (data.code === 'NO_PASSKEY') {
      return { ok: false, message: 'You have no passkey registered. Use your password instead.' }
    }
    return { ok: false, message: DELETION_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: DELETION_RETRY_MESSAGE }
  }
}

export async function submitDeletionPasskeyReauth(
  assertion: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<DeletionReauthOutcome> {
  try {
    const response = await fetchImpl(DELETION_REAUTH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'passkey', response: assertion }),
      credentials: 'include',
    })
    if (response.ok) {
      const data = (await response.json()) as { ticket?: string }
      if (typeof data.ticket === 'string' && data.ticket) return { ok: true, ticket: data.ticket }
      return { ok: false, message: DELETION_FAILED_MESSAGE }
    }
    if (response.status === 401) return { ok: false, message: DELETION_UNAUTHENTICATED_MESSAGE }
    if (response.status === 429) return { ok: false, message: DELETION_THROTTLED_MESSAGE }
    if (response.status >= 500) return { ok: false, message: DELETION_RETRY_MESSAGE }
    return { ok: false, message: 'The passkey did not verify. Try again or use your password.' }
  } catch {
    return { ok: false, message: DELETION_RETRY_MESSAGE }
  }
}

/**
 * The irreversible call. Requires the typed confirmation word and a fresh
 * re-auth ticket; anything else is refused by the server, never by this
 * helper alone.
 */
export async function submitAccountDeletion(
  confirmation: string,
  ticket: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeletionOutcome> {
  try {
    const response = await fetchImpl(DELETION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation, ticket }),
      credentials: 'include',
    })
    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as { alreadyDeleted?: boolean }
      return { ok: true, alreadyDeleted: data.alreadyDeleted === true }
    }
    if (response.status === 401) return { ok: false, message: DELETION_UNAUTHENTICATED_MESSAGE }
    if (response.status === 409) {
      const data = await readErrorCode(response)
      if (data.code === 'ACTIVE_SUBSCRIPTION') {
        return { ok: false, message: 'Cancel your subscription first, then delete your account.' }
      }
      if (data.code === 'SOLE_OWNER_OF_SHARED_WORKSPACE') {
        return {
          ok: false,
          message: 'One of your workspaces still has other members and only you as owner. Make someone else the owner first.',
        }
      }
      return { ok: false, message: DELETION_FAILED_MESSAGE }
    }
    if (response.status === 412) return { ok: false, message: DELETION_REAUTH_REQUIRED_MESSAGE }
    if (response.status === 429) return { ok: false, message: DELETION_THROTTLED_MESSAGE }
    if (response.status >= 500) return { ok: false, message: DELETION_RETRY_MESSAGE }
    const data = await readErrorCode(response)
    if (data.code === 'CONFIRMATION_MISMATCH') return { ok: false, message: DELETION_CONFIRMATION_REQUIRED_MESSAGE }
    return { ok: false, message: DELETION_FAILED_MESSAGE }
  } catch {
    return { ok: false, message: DELETION_RETRY_MESSAGE }
  }
}

/** True only for the exact confirmation word (whitespace tolerated). */
export function confirmationMatches(value: string): boolean {
  return value.trim() === DELETION_CONFIRMATION_WORD
}
