import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { isExpoGo } from '../expo-go'
import { LinkNotificationProvider, useNotifications } from './LinkNotificationProvider'

export { useNotifications }

type PushProvider = ComponentType<{ children: ReactNode }>

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [Push, setPush] = useState<PushProvider | null>(null)

  useEffect(() => {
    if (isExpoGo) return
    let cancelled = false
    void import('./NativePushProvider')
      .then((mod) => {
        if (!cancelled) setPush(() => mod.NativePushProvider)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (isExpoGo || !Push) return <LinkNotificationProvider>{children}</LinkNotificationProvider>
  return <Push>{children}</Push>
}
