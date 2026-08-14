import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Platform } from 'react-native'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { parsePushData } from '../linking'
import { NotificationContext } from './notification-context'
import { useSession } from './SessionProvider'
import { useAttentionLinks } from './useAttentionLinks'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export function NativePushProvider({ children }: { children: ReactNode }) {
  const { client, token } = useSession()
  const { openLink } = useAttentionLinks()
  const pushToken = useRef<string | null>(null)

  const register = useCallback(async () => {
    if (!client || !token || !Device.isDevice) return
    const existing = await Notifications.getPermissionsAsync()
    let status = existing.status
    if (status !== 'granted') {
      const asked = await Notifications.requestPermissionsAsync()
      status = asked.status
    }
    if (status !== 'granted') return
    const expoToken = await Notifications.getExpoPushTokenAsync()
    pushToken.current = expoToken.data
    const platform = Platform.OS === 'ios' ? 'ios' : 'android'
    await client.registerDevice(expoToken.data, platform)
  }, [client, token])

  useEffect(() => {
    if (!token) return
    register().catch(() => undefined)
  }, [register, token])

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
