import { View, Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'
import { INBOX_SCOPES, isInboxScope, type InboxScope } from './InboxScopeTabs.types'

export { INBOX_SCOPES, isInboxScope, type InboxScope }

export function InboxScopeTabs({ value, onChange }: { value: InboxScope; onChange: (scope: InboxScope) => void }) {
  return (
    <View style={styles.row}>
      {INBOX_SCOPES.map((scope) => (
        <Pressable key={scope} onPress={() => onChange(scope)} style={[styles.tab, value === scope && styles.active]}>
          <Text style={[styles.label, value === scope && styles.activeLabel]}>{scope}</Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  tab: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  active: { backgroundColor: colors.accent, borderColor: colors.accent },
  label: { fontSize: 13, color: colors.text, textTransform: 'capitalize' },
  activeLabel: { color: colors.accentFg },
})
