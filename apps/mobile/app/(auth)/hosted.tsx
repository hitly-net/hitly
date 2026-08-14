import { useState } from 'react'
import { Pressable, Text, TextInput, View, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { colors } from '../../src/theme'
import { normalizeBaseUrl } from '../../src/config'
import { useSession } from '../../src/providers/SessionProvider'

export default function HostedUrlForm() {
  const router = useRouter()
  const { chooseHosted } = useSession()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Hosted instance</Text>
      <Text style={styles.sub}>Enter the origin of your Hitly server.</Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="https://hitly.example.com"
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
            await chooseHosted(normalizeBaseUrl(url))
            router.push('/(auth)/login')
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not reach that URL')
          } finally {
            setPending(false)
          }
        }}
      >
        <Text style={styles.primaryLabel}>{pending ? 'Checking…' : 'Continue'}</Text>
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
  },
  error: { marginTop: 8, color: colors.danger, fontSize: 13 },
  primary: { marginTop: 16, backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14 },
  primaryLabel: { textAlign: 'center', color: colors.accentFg, fontWeight: '600' },
})
