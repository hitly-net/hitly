import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { setAppBadge } from '../badge'
import { parsePushData } from '../linking'
import { NotificationContext } from './notification-context'
import { useSession } from './SessionProvider'
import { useAttentionLinks } from './useAttentionLinks'
import type { createHitlyClient } from '../api/hitly-client'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

function expoProjectId() {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return Constants.easConfig?.projectId ?? extra?.eas?.projectId
}

type HitlyClient = ReturnType<typeof createHitlyClient>

export function NativePushProvider({ children }: { children: ReactNode }) {
  const { client, token } = useSession()
  const { openLink } = useAttentionLinks()
  const pushToken = useRef<string | null>(null)
  const lastAuthed = useRef<{ client: HitlyClient; expoToken: string } | null>(null)

  const registerToken = useCallback(
    async (expoPushToken: string) => {
      if (!client || !token) return
      pushToken.current = expoPushToken
      lastAuthed.current = { client, expoToken: expoPushToken }
      const platform = Platform.OS === 'ios' ? 'ios' : 'android'
      await client.registerPushToken(expoPushToken, platform)
    },
    [client, token],
  )

  const register = useCallback(async () => {
    if (!client || !token || !Device.isDevice) return
    const existing = await Notifications.getPermissionsAsync()
    let status = existing.status
    if (status !== 'granted') {
      const asked = await Notifications.requestPermissionsAsync()
      status = asked.status
    }
    if (status !== 'granted') return
    if (Platform.OS === 'android') {
      // The notification icon/tint come from the expo-notifications plugin
      // config in app.json (manifest default-notification metadata).
      await Notifications.setNotificationChannelAsync('hitly', {
        name: 'HITLy',
        importance: Notifications.AndroidImportance.DEFAULT,
        lightColor: '#2563eb',
      })
    }
    const projectId = expoProjectId()
    if (!projectId) return
    const expoToken = await Notifications.getExpoPushTokenAsync({ projectId })
    await registerToken(expoToken.data)
  }, [client, registerToken, token])

  useEffect(() => {
    if (!token) {
      const prev = lastAuthed.current
      lastAuthed.current = null
      if (prev?.expoToken) {
        void prev.client.unregisterPushToken(prev.expoToken).catch(() => undefined)
      }
      pushToken.current = null
      void setAppBadge(0)
      return
    }
    register().catch(() => undefined)
  }, [register, token])

  useEffect(() => {
    const sub = Notifications.addPushTokenListener((next) => {
      if (!next.data || next.data === pushToken.current) return
      void registerToken(next.data).catch(() => undefined)
    })
    return () => sub.remove()
  }, [registerToken])

  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener((notification) => {
      const badge = notification.request.content.badge
      if (typeof badge === 'number') void setAppBadge(badge)
    })
    return () => received.remove()
  }, [])

  useEffect(() => {
    const received = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>
      const link = parsePushData(data)
      if (link) void openLink(link.approvalId, link.instanceUrl)
    })
    return () => received.remove()
  }, [openLink])

  useEffect(() => {
    let mounted = true
    void Notifications.getLastNotificationResponseAsync().then((last) => {
      if (!mounted || !last) return
      const data = last.notification.request.content.data as Record<string, unknown>
      const link = parsePushData(data)
      if (link) void openLink(link.approvalId, link.instanceUrl)
    })
    return () => {
      mounted = false
    }
  }, [openLink])

  return (
    <NotificationContext.Provider value={{ register, supported: true, hint: '' }}>
      {children}
    </NotificationContext.Provider>
  )
}
