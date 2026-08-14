import { type ReactNode } from 'react'
import { Redirect } from 'expo-router'
import { useSession } from './providers/SessionProvider'

export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, token } = useSession()
  if (!ready) return null
  if (!token) return <Redirect href="/(auth)" />
  return <>{children}</>
}
