import { FlatList, Pressable, RefreshControl, ScrollView, Text, StyleSheet } from 'react-native'
import type { WorkItemRow } from '../../types'
import { colors } from '../../theme'
import { WorkItemRowView } from './WorkItemRow'

export function WorkItemList({
  items,
  onOpen,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  refreshing = false,
  onRefresh,
}: {
  items: WorkItemRow[]
  onOpen: (id: string) => void
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  refreshing?: boolean
  onRefresh?: () => void
}) {
  const refreshControl = onRefresh ? (
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text} />
  ) : undefined

  if (items.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={styles.emptyWrap}
        refreshControl={refreshControl}
      >
        <Text style={styles.empty}>No work items.</Text>
      </ScrollView>
    )
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <WorkItemRowView item={item} onPress={() => onOpen(item.id)} />}
      onEndReached={hasMore && !loadingMore && !refreshing ? onLoadMore : undefined}
      onEndReachedThreshold={0.4}
      refreshControl={refreshControl}
      ListFooterComponent={
        hasMore ? (
          <Pressable onPress={onLoadMore} disabled={loadingMore || refreshing} style={styles.more}>
            <Text style={styles.moreText}>{loadingMore ? 'Loading…' : 'More items — load more'}</Text>
          </Pressable>
        ) : null
      }
    />
  )
}

const styles = StyleSheet.create({
  emptyWrap: { flexGrow: 1, justifyContent: 'center' },
  empty: { marginTop: 24, color: colors.muted, textAlign: 'center' },
  more: { paddingVertical: 16, alignItems: 'center' },
  moreText: { color: colors.muted, fontSize: 14 },
})
