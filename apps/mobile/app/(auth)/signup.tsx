import { useState } from 'react'
import { Pressable, Text, TextInput, View, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { colors } from '../../src/theme'
import { useSession } from '../../src/providers/SessionProvider'

export default function SignupScreen() {
  const { instance, signUp, consumePendingLink } = useSession()
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Create account</Text>
      <Text style={styles.sub}>{instance?.label ?? 'HITLy'}</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.muted} style={styles.input} />
      <TextInput
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="Email"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="Password (8+ characters)"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        disabled={pending}
        style={styles.primary}
        onPress={async () => {
          setPending(true)
          setError(null)
          try {
            await signUp(name, email, password)
            const pendingLink = await consumePendingLink()
            if (pendingLink) router.replace(`/inbox/${pendingLink.approvalId}`)
            else router.replace('/(tabs)')
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign up failed')
          } finally {
            setPending(false)
          }
        }}
      >
        <Text style={styles.primaryLabel}>{pending ? 'Creating…' : 'Create account'}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  sub: { marginTop: 8, marginBottom: 24, fontSize: 15, color: colors.muted },
  input: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
    color: colors.text,
    marginBottom: 12,
  },
  error: { marginBottom: 8, color: colors.danger, fontSize: 13 },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14 },
  primaryLabel: { textAlign: 'center', color: colors.accentFg, fontWeight: '600' },
})
