import { createContext, useContext } from 'react'

export type NotificationContextValue = {
  register: () => Promise<void>
  supported: boolean
  hint: string
}

export const WEB_HINT = 'Device notifications are available in the iOS and Android apps.'
export const EXPO_GO_HINT =
  'Remote push is not available in Expo Go. Use a development build to enable device notifications.'

export const NotificationContext = createContext<NotificationContextValue>({
  register: async () => undefined,
  supported: false,
  hint: WEB_HINT,
})

export function useNotifications() {
  return useContext(NotificationContext)
}
