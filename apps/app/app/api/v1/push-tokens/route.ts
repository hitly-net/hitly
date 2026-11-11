import { requireApiSession } from '@/lib/api-session'
import { createPushTokensDelete, createPushTokensPost } from '@/lib/push-tokens-route'
import { registerPushToken, unregisterPushToken } from '@/lib/push-tokens'

export const POST = createPushTokensPost({ requireApiSession, registerPushToken })
export const DELETE = createPushTokensDelete({ requireApiSession, unregisterPushToken })
