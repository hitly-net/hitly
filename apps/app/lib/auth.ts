import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import { bearer } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { eq } from 'drizzle-orm'
import { socialProviders } from '@hitly/cloud/auth/providers'
import * as schema from '@hitly/db/schema'
import { db } from './db'
import { isTrustedAppOrigin } from './cors'
import { sendMail } from './mail'
import { emailAndPasswordOptions } from './auth-email-password'
import { bootstrapUserWorkspaces } from './workspace'
import { isSignupEnabled } from './signup'
import { gateAccountCreation } from './invites'
import { currentInviteSignup } from './invite-signup'
import { issueEmailVerification } from './email-verification-issue'
import { resolveAuthSecret } from './auth-secret'
import { trustedProxyAuthOptions } from './trusted-proxies'
import { authLogger, handleAuthApiError } from './auth-logging'
import { authRateLimitEnabled, createAuthRateLimitStorage } from './rate-limit'
import { PASSKEY_USER_VERIFICATION } from './passkey'
import { webAuthnRelyingParty } from './webauthn-rp'

export { resolveAuthSecret } from './auth-secret'

const appUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

const staticTrustedOrigins = [
  appUrl,
  'hitly://',
  'exp://',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
]

function createAuth(database: NonNullable<typeof db>) {
  return betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        passkey: schema.passkeys,
      },
    }),
    emailAndPassword: emailAndPasswordOptions(appUrl, sendMail),
    socialProviders,
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Public signup, or a valid invite token for exactly this email,
            // validated and consumed here (lib/invites.ts). A pending invite
            // matched on email alone is not enough.
            await gateAccountCreation(user.email, isSignupEnabled())
            return { data: user }
          },
          after: async (user) => {
            await bootstrapUserWorkspaces({
              id: user.id,
              name: user.name,
              email: user.email,
            })
            // Invite accept proves the inbox and sets emailVerified itself.
            // Better Auth's emailVerification option is not used: 1.6.27 issues
            // a stateless JWT and confirms it with a GET. Public sign-up stores
            // a hashed single-use token instead (lib/email-verification-issue.ts).
            // A failure here must not undo the account that was just created.
            if (currentInviteSignup()) return
            try {
              await issueEmailVerification({ userId: user.id, email: user.email })
            } catch (error) {
              console.warn(
                `[hitly email-verification] Could not store the signup verification: ${error instanceof Error ? error.name : 'error'}`,
              )
            }
          },
        },
      },
    },
    baseURL: appUrl,
    secret: resolveAuthSecret(),
    trustedOrigins: async (request) => {
      const origin = request?.headers.get('origin')
      if (origin && isTrustedAppOrigin(origin) && !staticTrustedOrigins.includes(origin)) {
        return [...staticTrustedOrigins, origin]
      }
      return staticTrustedOrigins
    },
    // Never log tokens: redact Better Auth log lines, and turn unexpected
    // errors into a plain 500 with one value-free log line (lib/auth-logging.ts).
    logger: authLogger,
    onAPIError: { onError: handleAuthApiError },
    // Shared database-backed endpoint limiter (lib/rate-limit.ts): replaces
    // Better Auth's per-process in-memory storage, so auth limits hold across
    // server processes; the shared limiter keeps counting in process if the
    // database is unavailable. Enabled like Better Auth (production) unless
    // HITLY_RATE_LIMIT_AUTH_ENABLED=1/0 says otherwise.
    rateLimit: {
      enabled: authRateLimitEnabled(),
      customStorage: createAuthRateLimitStorage(),
    },
    // advanced.ipAddress.trustedProxies from HITLY_TRUSTED_PROXIES; nothing when unset.
    ...trustedProxyAuthOptions(),
    plugins: [
      bearer(),
      nextCookies(),
      passkey({
        ...webAuthnRelyingParty(),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: PASSKEY_USER_VERIFICATION,
        },
        authentication: {
          afterVerification: async ({ clientData }) => {
            try {
              await database
                .update(schema.passkeys)
                .set({ lastUsedAt: new Date() })
                .where(eq(schema.passkeys.credentialID, clientData.id))
            } catch {
              // Sign-in already succeeded; last-used is best-effort.
            }
          },
        },
      }),
    ],
  })
}

type AuthInstance = ReturnType<typeof createAuth>

/**
 * The auth instance is created on first use rather than when this module is
 * loaded, so importing the module (for example while `next build` collects
 * page data) never needs the secret. The secret requirement is enforced when
 * the instance is created, and at server start (instrumentation.ts).
 */
function lazyAuth(database: NonNullable<typeof db>): AuthInstance {
  let instance: AuthInstance | null = null
  const resolve = () => (instance ??= createAuth(database))
  return new Proxy({} as AuthInstance, {
    get: (_target, prop) => Reflect.get(resolve(), prop),
    has: (_target, prop) => Reflect.has(resolve(), prop),
  })
}

export const auth: AuthInstance | null = db ? lazyAuth(db) : null

