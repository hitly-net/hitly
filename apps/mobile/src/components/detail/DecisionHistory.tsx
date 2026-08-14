import { View, Text, StyleSheet } from 'react-native'
import type { DecisionRow } from '../../types'
import { colors } from '../../theme'

export function DecisionHistory({ decisions }: { decisions: DecisionRow[] }) {
  const latest = decisions[0]
  if (!latest) return null
  return (
    <View style={styles.block}>
      <Text style={styles.heading}>Decision</Text>
      <Text style={styles.meta}>
        {latest.decision}
        {latest.resumeError ? ' · resume failed' : ''}
      </Text>
      {latest.resumeError ? <Text style={styles.error}>{latest.resumeError}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  block: { marginTop: 24 },
  heading: { fontSize: 13, fontWeight: '600', color: colors.text },
  meta: { marginTop: 4, fontSize: 14, color: colors.muted, textTransform: 'capitalize' },
  error: { marginTop: 8, fontSize: 13, color: colors.warning },
})
