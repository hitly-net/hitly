import { Pressable, Text, View, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { colors } from '../../src/theme'
import { useSession } from '../../src/providers/SessionProvider'
import { HitlyMark, HitlyWordmark } from '../../src/components/brand/HitlyBrand'

export default function InstanceGate() {
  const router = useRouter()
  const { chooseCloud } = useSession()

  return (
    <View style={styles.screen}>
      <View style={styles.mark}>
        <HitlyMark size={96} />
      </View>
      <Text style={styles.sub}>Sign in to Cloud or a hosted instance.</Text>
      <Pressable
        style={styles.primary}
        onPress={async () => {
          await chooseCloud()
          router.push('/(auth)/login')
        }}
      >
        <View style={styles.primaryLabel}>
          <HitlyWordmark size={16} color={colors.accentFg} />
          <Text style={styles.primaryLabelText}> Cloud</Text>
        </View>
      </Pressable>
      <Pressable style={styles.secondary} onPress={() => router.push('/(auth)/hosted')}>
        <Text style={styles.secondaryLabel}>Hosted instance</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  mark: { alignItems: 'center', marginBottom: 16 },
  sub: { marginBottom: 32, fontSize: 15, color: colors.muted, textAlign: 'center' },
  primary: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, marginBottom: 12 },
  primaryLabel: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center' },
  primaryLabelText: { color: colors.accentFg, fontWeight: '600', fontSize: 16 },
  secondary: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 14 },
  secondaryLabel: { textAlign: 'center', color: colors.text, fontWeight: '600' },
})
