import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import * as schema from '@hitly/db/schema'
import { db } from './db'

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
        sendResetPassword: async () => {
          // Wire a mailer before launch.
        },
      },
      baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
      secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-change-me-please-32ch',
      plugins: [nextCookies()],
    })
  : null
