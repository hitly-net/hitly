import { useCallback, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { colors } from '../../src/theme'
import { useSession } from '../../src/providers/SessionProvider'
import { InboxScopeTabs } from '../../src/components/inbox/InboxScopeTabs'
import { InboxSearch } from '../../src/components/inbox/InboxSearch'
import { WorkItemList } from '../../src/components/inbox/WorkItemList'
import { ScreenTitle } from '../../src/components/nav/ScreenTitle'
import { inboxFilterKey, useListFilters } from '../../src/use-list-filters'
import { useAttention } from '../../src/providers/AttentionProvider'
import { appendInboxItems, fetchInboxPage } from '../../src/inbox-pages'
import type { WorkItemRow } from '../../src/types'

export default function InboxListScreen() {
  const { client, workspaceId } = useSession()
  const { screenEpoch, refresh } = useAttention()
  const router = useRouter()
  const { scope, setScope, q, setQ, ready } = useListFilters(workspaceId ? inboxFilterKey(workspaceId) : null)
  const [items, setItems] = useState<WorkItemRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    if (!client || !ready) return
    const data = await fetchInboxPage(client.inbox, { scope, q: q.trim() || undefined })
    setItems(data.items)
    setNextCursor(data.nextCursor)
    void refresh()
  }, [client, q, ready, refresh, scope])

  const loadMore = useCallback(async () => {
    if (!client || !ready || !nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const data = await fetchInboxPage(client.inbox, { scope, q: q.trim() || undefined }, nextCursor)
      setItems((prev) => appendInboxItems(prev, data.items))
      setNextCursor(data.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }, [client, loadingMore, nextCursor, q, ready, scope])

  useFocusEffect(
    useCallback(() => {
      void load().catch(() => {
        setItems([])
        setNextCursor(null)
      })
    }, [load, screenEpoch]),
  )

  return (
    <View style={styles.screen}>
      <ScreenTitle>Inbox</ScreenTitle>
      <InboxScopeTabs value={scope} onChange={setScope} />
      <InboxSearch value={q} onChange={setQ} />
      <WorkItemList
        items={items}
        onOpen={(id) => router.push(`/inbox/${id}`)}
        hasMore={Boolean(nextCursor)}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: colors.bg },
})
