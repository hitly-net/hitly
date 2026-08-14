import { View, Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export const INBOX_SCOPES = ['open', 'all', 'closed'] as const
export type InboxScope = (typeof INBOX_SCOPES)[number]

export function isInboxScope(value: string | undefined): value is InboxScope {
  return Boolean(value && (INBOX_SCOPES as readonly string[]).includes(value))
}

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
