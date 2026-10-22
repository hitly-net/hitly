import { RESET_PASSWORD_PAGE } from './password-reset'
import { resetCheckLimiter } from './reset-check-limit'

/**
 * Checks a reset link's token on the server before the reset page shows the
 * new-password form.
 *
 * It calls Better Auth's reset-password callback endpoint
 * (GET /api/auth/reset-password/:token) in process, with the reset page as a
 * relative callback URL. That endpoint only looks the token up: it never
 * consumes it, so opening or reloading the page does not use up the link.
 * Only the form submission (POST /api/auth/reset-password) consumes it.
 *
 * The page only shows the form when the check says the token is valid. If the
 * check cannot answer, the page shows a "try again" state instead.
 *
 * Nothing here logs the token or an error that could carry it.
 */

export type ResetTokenState = 'valid' | 'invalid' | 'unknown'

type ResetCallbackInput = {
  params: { token: string }
  query: { callbackURL: string }
  asResponse: true
}

export type ResetCallbackApi = {
  api: { requestPasswordResetCallback: (input: ResetCallbackInput) => Promise<unknown> }
}

/**
 * Reset tokens are generated from letters and digits. Anything with other
 * characters (control characters, spaces, percent signs, non-ASCII) or of an
 * implausible length cannot be a real token, so it is invalid without a lookup.
 */
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isWellFormedResetToken(token: unknown): token is string {
  return typeof token === 'string' && RESET_TOKEN_PATTERN.test(token)
}

export async function checkResetToken(auth: ResetCallbackApi, token: string): Promise<ResetTokenState> {
  if (!isWellFormedResetToken(token)) return 'invalid'
  try {
    const response = await auth.api.requestPasswordResetCallback({
      params: { token },
      query: { callbackURL: RESET_PASSWORD_PAGE },
      asResponse: true,
    })
    if (!(response instanceof Response)) return 'unknown'
    const location = response.headers.get('location')
    if (!location) return 'unknown'
    const target = new URL(location, 'http://localhost')
    if (target.searchParams.has('error')) return 'invalid'
    if (target.searchParams.get('token') === token) return 'valid'
    return 'unknown'
  } catch {
    // Database errors can include query parameters, so log a fixed line only.
    console.error('[hitly password-reset] Could not check a reset link; showing the retry state')
    return 'unknown'
  }
}

type SearchParams = { token?: string | string[]; error?: string | string[] }

/** What the reset page shows: the form, the "invalid or expired" state, or the "try again" state. */
export type ResetPageState = { kind: 'form'; token: string } | { kind: 'invalid' } | { kind: 'unavailable' }

const INVALID: ResetPageState = { kind: 'invalid' }
const UNAVAILABLE: ResetPageState = { kind: 'unavailable' }

/**
 * A missing or malformed token, or an `error` parameter, gives the invalid
 * state without a check. A token the server reports as valid gives the form;
 * one it reports as invalid or expired gives the invalid state. If there is no
 * check, or it fails or cannot answer, the page shows the "try again" state
 * and never the form.
 */
export async function resolveResetPageState(
  params: SearchParams,
  check: ((token: string) => Promise<ResetTokenState>) | null,
): Promise<ResetPageState> {
  if (params.error !== undefined) return INVALID
  if (!isWellFormedResetToken(params.token)) return INVALID
  const token = params.token
  if (!check) return UNAVAILABLE
  let state: ResetTokenState
  try {
    state = await check(token)
  } catch {
    return UNAVAILABLE
  }
  if (state === 'valid') return { kind: 'form', token }
  if (state === 'invalid') return INVALID
  return UNAVAILABLE
}

/**
 * The reset page's wiring: checks the token with the app's auth instance
 * (null when the app has no database), limited per client.
 */
export async function loadResetPageState(
  params: SearchParams,
  {
    auth,
    clientKey,
    allow = resetCheckLimiter,
  }: { auth: ResetCallbackApi | null; clientKey: string; allow?: (key: string) => boolean },
): Promise<ResetPageState> {
  const check = auth
    ? async (token: string): Promise<ResetTokenState> => (allow(clientKey) ? checkResetToken(auth, token) : 'unknown')
    : null
  return resolveResetPageState(params, check)
}
