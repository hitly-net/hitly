import { Text, View, StyleSheet } from 'react-native'
import { colors } from '../../theme'
import { useSession } from '../../providers/SessionProvider'

export function InstanceCard() {
  const { instance } = useSession()
  if (!instance) return null
  return (
    <View style={styles.card}>
      <Text style={styles.label}>Instance</Text>
      <Text style={styles.value}>{instance.label}</Text>
      <Text style={styles.meta}>{instance.baseUrl}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    backgroundColor: colors.card,
    marginBottom: 16,
  },
  label: { fontSize: 12, color: colors.muted },
  value: { marginTop: 4, fontSize: 16, fontWeight: '600', color: colors.text },
  meta: { marginTop: 4, fontSize: 12, color: colors.muted },
})
