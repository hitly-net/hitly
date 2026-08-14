import { Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function AttentionCard({
  label,
  count,
  onPress,
}: {
  label: string
  count: number
  onPress: () => void
}) {
  return (
    <Pressable onPress={onPress} style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.count}>{count}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    backgroundColor: colors.card,
    marginBottom: 12,
  },
  label: { fontSize: 13, color: colors.muted },
  count: { marginTop: 8, fontSize: 28, fontWeight: '600', color: colors.text },
})
