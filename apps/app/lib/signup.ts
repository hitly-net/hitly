export function isSignupEnabled(): boolean {
  const value = process.env.HITLY_SIGNUP_ENABLED
  if (!value || value === '1' || value === 'true') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  return true
}

/**
 * `/signup?invite=<token>` is accepted as an alias of the invite accept page,
 * so an invite link works whether or not public signup is on. The token is
 * only checked for shape here; the accept route and the user-create hook
 * validate it server-side.
 */
export function inviteAcceptPathFromSignup(invite: unknown): string | null {
  if (typeof invite !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invite)) return null
  return `/invite/${invite}`
}
