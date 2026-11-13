import { isBooleanFlag } from './boolean-flag'

export function isSignupEnabled(): boolean {
  // Shared parser (lib/boolean-flag.ts): 1/true/yes/on => on, 0/false/off => off,
  // unset or unrecognised => the default (on). An unrecognised value earns one
  // value-free startup warning; behaviour otherwise matches the old reader.
  return isBooleanFlag('HITLY_SIGNUP_ENABLED', true)
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
