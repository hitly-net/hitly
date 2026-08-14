import { Redirect } from 'expo-router'
import { useSession } from '../src/providers/SessionProvider'

export default function Index() {
  const { ready, instance, token } = useSession()
  if (!ready) return null
  if (!instance) return <Redirect href="/(auth)" />
  if (!token) return <Redirect href="/(auth)/login" />
  return <Redirect href="/(tabs)" />
}
