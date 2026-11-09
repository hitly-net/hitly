import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Carries an invite token from the invite accept route into Better Auth's
 * user-create hook. The hook itself validates and consumes the token
 * (lib/invites.ts gateAccountCreation); nothing here trusts the page.
 */
export type InviteSignupContext = {
  token: string
  /** Set by the hook when it has consumed the invite. */
  claimed: { id: string; workspaceId: string; role: string; acceptedAt: Date | null } | null
  /** Set by the hook when it refused the token. */
  refusal: string | null
}

const store = new AsyncLocalStorage<InviteSignupContext>()

export function normaliseEmail(email: string) {
  return email.trim().toLowerCase()
}

export function runWithInviteSignup<T>(context: InviteSignupContext, fn: () => Promise<T>): Promise<T> {
  return store.run(context, fn)
}

export function currentInviteSignup(): InviteSignupContext | undefined {
  return store.getStore()
}
