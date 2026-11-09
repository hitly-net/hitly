import { eq } from 'drizzle-orm'
import { users } from '@hitly/db/schema'
import { auth } from './auth'
import { db } from './db'
import type { InviteRouteDeps } from './invite-routes'

/** Production wiring of the invite routes to Better Auth and the database. */
export const inviteRouteDeps: InviteRouteDeps = {
  async getSessionUser(request) {
    if (!auth) return null
    const session = await auth.api.getSession({ headers: request.headers })
    return session?.user ? { id: session.user.id, email: session.user.email } : null
  },
  async findUserIdByEmail(email) {
    if (!db) return null
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    return rows[0]?.id ?? null
  },
  async signUp(request, body) {
    if (!auth) throw new Error('Auth is not configured')
    const { headers, response } = await auth.api.signUpEmail({
      body,
      headers: request.headers,
      returnHeaders: true,
    })
    return { userId: response.user.id, setCookies: headers.getSetCookie() }
  },
}
