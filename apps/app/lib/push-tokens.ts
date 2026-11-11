import { and, eq, inArray } from 'drizzle-orm'
import { pushTokens } from '@hitly/db/schema'
import { newId } from './ids'
import { requireDb } from './require-db'

export const PUSH_PLATFORMS = ['ios', 'android'] as const
export type PushPlatform = (typeof PUSH_PLATFORMS)[number]

export function isPushPlatform(value: unknown): value is PushPlatform {
  return typeof value === 'string' && (PUSH_PLATFORMS as readonly string[]).includes(value)
}

export async function registerPushToken(args: { userId: string; token: string; platform: PushPlatform }) {
  const database = requireDb()
  const existing = await database.select().from(pushTokens).where(eq(pushTokens.token, args.token)).limit(1)
  const row = existing[0]
  const now = new Date()
  if (row) {
    await database
      .update(pushTokens)
      .set({ userId: args.userId, platform: args.platform, lastSeenAt: now })
      .where(eq(pushTokens.id, row.id))
    return { id: row.id, created: false as const }
  }
  const id = newId('ptk').slice(0, 36)
  await database.insert(pushTokens).values({
    id,
    userId: args.userId,
    token: args.token,
    platform: args.platform,
    lastSeenAt: now,
  })
  return { id, created: true as const }
}

export async function unregisterPushToken(args: { userId: string; token: string }) {
  const database = requireDb()
  await database.delete(pushTokens).where(and(eq(pushTokens.userId, args.userId), eq(pushTokens.token, args.token)))
}

export async function listPushTokens(userId: string) {
  const database = requireDb()
  return database
    .select({ token: pushTokens.token, platform: pushTokens.platform })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId))
}

/** Drop dead Expo tokens. Not user-scoped: DeviceNotRegistered means the token is gone. */
export async function deletePushTokensByValue(tokens: string[]) {
  const unique = [...new Set(tokens.filter(Boolean))]
  if (unique.length === 0) return
  const database = requireDb()
  await database.delete(pushTokens).where(inArray(pushTokens.token, unique))
}
