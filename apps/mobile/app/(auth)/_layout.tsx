import { Redirect, Stack } from 'expo-router'
import { useSession } from '../../src/providers/SessionProvider'

export default function AuthLayout() {
  const { ready, token } = useSession()
  if (!ready) return null
  if (token) return <Redirect href="/(tabs)" />
  return <Stack screenOptions={{ headerShown: false }} />
}
