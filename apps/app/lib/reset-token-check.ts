import { RESET_PASSWORD_PAGE } from './password-reset'

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

export async function checkResetToken(auth: ResetCallbackApi, token: string): Promise<ResetTokenState> {
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
    console.error('[hitly password-reset] Could not check a reset link; showing the form')
    return 'unknown'
  }
}

type SearchParams = { token?: string | string[]; error?: string | string[] }

/**
 * Picks the token the reset page should offer the form for, or null for the
 * "invalid or expired" state. A missing token, an `error` parameter, or a
 * token the server reports as invalid or expired all give null. If the check
 * itself fails, the form is shown and the submission decides.
 */
export async function resolveResetPageToken(
  params: SearchParams,
  check: ((token: string) => Promise<ResetTokenState>) | null,
): Promise<string | null> {
  if (params.error !== undefined) return null
  const token = typeof params.token === 'string' && params.token ? params.token : null
  if (!token) return null
  if (!check) return token
  return (await check(token)) === 'invalid' ? null : token
}
