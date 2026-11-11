import { and, eq } from 'drizzle-orm'
import { userDevices } from '@hitly/db/schema'
import { newId } from './ids'
import { registerPushToken, unregisterPushToken } from './push-tokens'
import { requireDb } from './require-db'

export const DEVICE_PLATFORMS = ['ios', 'android'] as const
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return typeof value === 'string' && (DEVICE_PLATFORMS as readonly string[]).includes(value)
}

export async function registerUserDevice(args: {
  userId: string
  token: string
  platform: DevicePlatform
}) {
  const database = requireDb()
  const existing = await database
    .select()
    .from(userDevices)
    .where(eq(userDevices.expoPushToken, args.token))
    .limit(1)
  const row = existing[0]
  if (row) {
    await database
      .update(userDevices)
      .set({ userId: args.userId, platform: args.platform })
      .where(eq(userDevices.id, row.id))
    await registerPushToken({ userId: args.userId, token: args.token, platform: args.platform }).catch(() => undefined)
    return { id: row.id, created: false as const }
  }
  const id = newId('dev').slice(0, 36)
  await database.insert(userDevices).values({
    id,
    userId: args.userId,
    expoPushToken: args.token,
    platform: args.platform,
  })
  await registerPushToken({ userId: args.userId, token: args.token, platform: args.platform }).catch(() => undefined)
  return { id, created: true as const }
}

export async function unregisterUserDevice(args: { userId: string; token: string }) {
  const database = requireDb()
  await database
    .delete(userDevices)
    .where(and(eq(userDevices.userId, args.userId), eq(userDevices.expoPushToken, args.token)))
  await unregisterPushToken(args).catch(() => undefined)
}

export async function listUserDeviceTokens(userId: string) {
  const database = requireDb()
  return database
    .select({ token: userDevices.expoPushToken, platform: userDevices.platform })
    .from(userDevices)
    .where(eq(userDevices.userId, userId))
}
