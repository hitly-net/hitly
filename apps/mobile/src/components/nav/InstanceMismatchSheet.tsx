import { Modal, Pressable, Text, View, StyleSheet } from 'react-native'
import { colors } from '../../theme'
import { useSession } from '../../providers/SessionProvider'

export function InstanceMismatchSheet() {
  const { mismatch, clearMismatch, instance } = useSession()
  if (!mismatch) return null
  return (
    <Modal transparent visible animationType="fade" onRequestClose={clearMismatch}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Different instance</Text>
          <Text style={styles.body}>
            This link is for {mismatch.instanceUrl ?? 'another Hitly server'}. You are signed into{' '}
            {instance?.label ?? instance?.baseUrl}.
          </Text>
          <Pressable onPress={clearMismatch} style={styles.button}>
            <Text style={styles.label}>Stay here</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 20 },
  title: { fontSize: 18, fontWeight: '600', color: colors.text },
  body: { marginTop: 8, fontSize: 14, color: colors.muted, lineHeight: 20 },
  button: { marginTop: 16, backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 12 },
  label: { textAlign: 'center', color: colors.accentFg, fontWeight: '600' },
})
