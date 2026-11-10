import { FlatList, Pressable, Text, StyleSheet } from 'react-native'
import type { WorkItemRow } from '../../types'
import { colors } from '../../theme'
import { WorkItemRowView } from './WorkItemRow'

export function WorkItemList({
  items,
  onOpen,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  items: WorkItemRow[]
  onOpen: (id: string) => void
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
}) {
  if (items.length === 0) {
    return <Text style={styles.empty}>No work items.</Text>
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <WorkItemRowView item={item} onPress={() => onOpen(item.id)} />}
      onEndReached={hasMore && !loadingMore ? onLoadMore : undefined}
      onEndReachedThreshold={0.4}
      ListFooterComponent={
        hasMore ? (
          <Pressable onPress={onLoadMore} disabled={loadingMore} style={styles.more}>
            <Text style={styles.moreText}>{loadingMore ? 'Loading…' : 'More items — load more'}</Text>
          </Pressable>
        ) : null
      }
    />
  )
}

const styles = StyleSheet.create({
  empty: { marginTop: 24, color: colors.muted, textAlign: 'center' },
  more: { paddingVertical: 16, alignItems: 'center' },
  moreText: { color: colors.muted, fontSize: 14 },
})
