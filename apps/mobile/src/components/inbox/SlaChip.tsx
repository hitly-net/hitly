import { Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function SlaChip({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return null
  const minutes = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000)
  if (!Number.isFinite(minutes)) return null
  const label = minutes <= 0 ? 'Expired' : minutes < 60 ? `${minutes}m left` : `${Math.round(minutes / 60)}h left`
  const urgent = minutes <= 15
  return <Text style={[styles.chip, urgent && styles.urgent]}>{label}</Text>
}

const styles = StyleSheet.create({
  chip: { fontSize: 12, color: colors.muted },
  urgent: { color: colors.warning, fontWeight: '600' },
})
