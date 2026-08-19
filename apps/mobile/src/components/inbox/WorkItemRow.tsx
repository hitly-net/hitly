import { Pressable, View, Text, StyleSheet } from 'react-native'
import type { WorkItemRow } from '../../types'
import { colors } from '../../theme'
import { PluginMark } from './PluginMark'
import { SlaChip } from './SlaChip'
import { resultLabel } from './WorkItemRow.helpers'

export { resultLabel }

export function WorkItemRowView({ item, onPress }: { item: WorkItemRow; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <PluginMark plugin={item.plugin} />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {item.actionName}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {item.projectName} · {resultLabel(item)}
        </Text>
      </View>
      {item.status === 'decided' ? null : <SlaChip expiresAt={item.expiresAt} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  meta: { marginTop: 2, fontSize: 12, color: colors.muted },
})
