import { type ReactNode } from 'react'
import { isExpoGo } from '../expo-go'
import {
  EXPO_GO_HINT,
  NotificationContext,
  WEB_HINT,
  useNotifications,
} from './notification-context'
import { useAttentionLinks } from './useAttentionLinks'

export { useNotifications }

export function LinkNotificationProvider({ children }: { children: ReactNode }) {
  useAttentionLinks()
  return (
    <NotificationContext.Provider
      value={{
        register: async () => undefined,
        supported: false,
        hint: isExpoGo ? EXPO_GO_HINT : WEB_HINT,
      }}
    >
      {children}
    </NotificationContext.Provider>
  )
}
