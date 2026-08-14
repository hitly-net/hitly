import { Pressable, Text, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { colors } from '../../theme'
import { useSession } from '../../providers/SessionProvider'

export function SignOutButton() {
  const { signOut } = useSession()
  const router = useRouter()
  return (
    <Pressable
      onPress={async () => {
        await signOut()
        router.replace('/(auth)')
      }}
      style={styles.btn}
    >
      <Text style={styles.label}>Sign out</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  btn: { paddingVertical: 12 },
  label: { fontSize: 15, color: colors.danger, fontWeight: '600' },
})
