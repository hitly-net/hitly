import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import { bearer } from 'better-auth/plugins'
import { socialProviders } from '@hitly/cloud/auth/providers'
import * as schema from '@hitly/db/schema'
import { db } from './db'
import { isTrustedAppOrigin } from './cors'
import { bootstrapUserWorkspaces } from './workspace'
import { sendMail } from './mail'

const appUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

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
        provider: 'mysql',
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
      secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-change-me-please-32ch',
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
