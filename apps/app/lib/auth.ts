import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import { bearer } from 'better-auth/plugins'
import { socialProviders } from '@hitly/cloud/auth/providers'
import * as schema from '@hitly/db/schema'
import { db } from './db'
import { isTrustedAppOrigin } from './cors'
import { sendMail } from './mail'
import { bootstrapUserWorkspaces } from './workspace'
import { isSignupEnabled } from './signup'

const appUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

/**
 * Resolves the auth signing secret. Production must provide
 * BETTER_AUTH_SECRET; startup fails when it is missing. The `next build`
 * phase is not startup, so collecting page data there may use the
 * development value; outside production a clearly-labelled dev-only value
 * keeps local runs and tests working.
 */
export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET
  if (env.NODE_ENV === 'production' && env.NEXT_PHASE !== 'phase-production-build') {
    throw new Error('BETTER_AUTH_SECRET must be set in production; refusing to start.')
  }
  return 'dev-only-change-me-please-32ch'
}

const staticTrustedOrigins = [
  appUrl,
  'hitly://',
  'exp://',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
]

export const auth = db
  ? betterAuth({
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: schema.users,
          session: schema.sessions,
          account: schema.accounts,
          verification: schema.verifications,
        },
      }),
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url }) => {
          void sendMail({
            to: user.email,
            subject: 'Hitly: Reset your password',
            text: `Click the link to reset your password:\n\n${url}\n\nIf you did not request a password reset, please ignore this email.`,
          }).catch((error) => {
            console.error('[hitly password-reset] Failed to send reset email:', error)
          })
        },
      },
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
      plugins: [bearer(), nextCookies()],
    })
  : null
