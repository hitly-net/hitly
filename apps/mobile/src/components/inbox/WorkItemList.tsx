import { FlatList, Text, StyleSheet } from 'react-native'
import type { WorkItemRow } from '../../types'
import { colors } from '../../theme'
import { WorkItemRowView } from './WorkItemRow'

export function WorkItemList({
  items,
  onOpen,
}: {
  items: WorkItemRow[]
  onOpen: (id: string) => void
}) {
  if (items.length === 0) {
    return <Text style={styles.empty}>No work items.</Text>
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <WorkItemRowView item={item} onPress={() => onOpen(item.id)} />}
    />
  )
}

const styles = StyleSheet.create({
  empty: { marginTop: 24, color: colors.muted, textAlign: 'center' },
})
