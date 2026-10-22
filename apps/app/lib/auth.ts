import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import { bearer } from 'better-auth/plugins'
import { socialProviders } from '@hitly/cloud/auth/providers'
import * as schema from '@hitly/db/schema'
import { db } from './db'
import { isTrustedAppOrigin } from './cors'
import { sendMail } from './mail'
import { emailAndPasswordOptions } from './auth-email-password'
import { bootstrapUserWorkspaces } from './workspace'
import { isSignupEnabled } from './signup'
import { resolveAuthSecret } from './auth-secret'
import { trustedProxyAuthOptions } from './trusted-proxies'

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
      },
    }),
    emailAndPassword: emailAndPasswordOptions(appUrl, sendMail),
    socialProviders,
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isSignupEnabled()) {
              throw new Error('Account creation is currently disabled. Contact us for early access.')
            }
            return { data: user }
          },
          after: async (user) => {
            await bootstrapUserWorkspaces({
              id: user.id,
              name: user.name,
              email: user.email,
            })
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
    // advanced.ipAddress.trustedProxies from HITLY_TRUSTED_PROXIES; nothing when unset.
    ...trustedProxyAuthOptions(),
    plugins: [bearer(), nextCookies()],
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

