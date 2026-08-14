import { View, Text, StyleSheet } from 'react-native'
import type { OriginField } from '../../types'
import { colors } from '../../theme'

export function OriginCard({ fields }: { fields: OriginField[] }) {
  if (fields.length === 0) return null
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Origin</Text>
      {fields.map((field) => (
        <View key={field.key} style={styles.row}>
          <Text style={styles.label}>{field.label}</Text>
          <Text style={styles.value}>{field.value}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    backgroundColor: colors.card,
  },
  heading: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 8 },
  row: { marginTop: 8 },
  label: { fontSize: 12, color: colors.muted },
  value: { fontSize: 13, color: colors.text, fontFamily: 'Courier' },
})
