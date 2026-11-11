'use client'

import { createAuthClient } from 'better-auth/client'
import { passkeyClient } from '@better-auth/passkey/client'

/**
 * Browser Better Auth client with the passkey plugin. Sign-in uses
 * `authClient.signIn.passkey()` (including conditional UI / autofill).
 * Register, rename and delete stay on /api/session/passkey so they can
 * require the current password.
 */
export const authClient = createAuthClient({
  plugins: [passkeyClient()],
})
