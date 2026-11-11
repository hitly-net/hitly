import { and, asc, eq, inArray } from 'drizzle-orm'
import { pushTokens } from '@hitly/db/schema'
import { newId } from './ids'
import { requireDb } from './require-db'

export const PUSH_PLATFORMS = ['ios', 'android'] as const
export type PushPlatform = (typeof PUSH_PLATFORMS)[number]

/** Per-user cap; oldest (createdAt, then id) is evicted when a 21st token is registered. */
export const MAX_PUSH_TOKENS_PER_USER = 20

export function isPushPlatform(value: unknown): value is PushPlatform {
  return typeof value === 'string' && (PUSH_PLATFORMS as readonly string[]).includes(value)
}

/** Expo token shapes the mobile client sends. Anything else is 400. */
export function isExpoPushToken(value: string): boolean {
  if (!value || value.length > 255) return false
  return /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(value)
}

async function evictOldestPushTokens(userId: string) {
  const database = requireDb()
  const rows = await database
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId))
    .orderBy(asc(pushTokens.createdAt), asc(pushTokens.id))
  if (rows.length <= MAX_PUSH_TOKENS_PER_USER) return
  const extra = rows.slice(0, rows.length - MAX_PUSH_TOKENS_PER_USER)
  await database.delete(pushTokens).where(
    inArray(
      pushTokens.id,
      extra.map((row) => row.id),
    ),
  )
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
    await evictOldestPushTokens(args.userId)
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
  await evictOldestPushTokens(args.userId)
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
