import { ScrollView, Text, StyleSheet } from 'react-native'
import { colors } from '../src/theme'
import { AuthGate } from '../src/auth-gate'
import { useSession } from '../src/providers/SessionProvider'
import { InstanceCard } from '../src/components/settings/InstanceCard'
import { NotificationToggle } from '../src/components/settings/NotificationToggle'
import { SignOutButton } from '../src/components/settings/SignOutButton'
import { ScreenTitle } from '../src/components/nav/ScreenTitle'

export default function ConfigScreen() {
  return (
    <AuthGate>
      <ConfigBody />
    </AuthGate>
  )
}

function ConfigBody() {
  const { user } = useSession()
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <ScreenTitle>Config</ScreenTitle>
      <Text style={styles.meta}>{user?.email}</Text>
      <InstanceCard />
      <NotificationToggle />
      <SignOutButton />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 16, backgroundColor: colors.bg, flexGrow: 1 },
  meta: { marginBottom: 16, color: colors.muted },
})
