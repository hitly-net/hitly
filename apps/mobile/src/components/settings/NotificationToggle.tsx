import { Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'
import { useNotifications } from '../../providers/NotificationProvider'

export function NotificationToggle() {
  const { register, supported, hint } = useNotifications()
  if (!supported) {
    return <Text style={styles.hint}>{hint}</Text>
  }
  return (
    <Pressable onPress={() => void register()} style={styles.btn}>
      <Text style={styles.label}>Enable device notifications</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  btn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    backgroundColor: colors.card,
  },
  label: { fontSize: 15, color: colors.text },
  hint: { fontSize: 13, color: colors.muted, marginBottom: 16 },
})
