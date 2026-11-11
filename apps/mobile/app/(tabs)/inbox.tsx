import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, View, StyleSheet } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import Ionicons from '@expo/vector-icons/Ionicons'
import { colors } from '../../src/theme'
import { useSession } from '../../src/providers/SessionProvider'
import { InboxScopeTabs } from '../../src/components/inbox/InboxScopeTabs'
import { InboxSearch } from '../../src/components/inbox/InboxSearch'
import { WorkItemList } from '../../src/components/inbox/WorkItemList'
import { ScreenTitle } from '../../src/components/nav/ScreenTitle'
import { inboxFilterKey, useListFilters } from '../../src/use-list-filters'
import { inboxScopeFromParam } from '../../src/inbox-scope-param'
import { useAttention } from '../../src/providers/AttentionProvider'
import { appendInboxItems, fetchInboxPage } from '../../src/inbox-pages'
import { createInboxRefreshGate } from '../../src/inbox-refresh'
import type { WorkItemRow } from '../../src/types'

export default function InboxListScreen() {
  const { client, workspaceId } = useSession()
  const { screenEpoch, refresh } = useAttention()
  const router = useRouter()
  const { scope, setScope, q, setQ, ready } = useListFilters(workspaceId ? inboxFilterKey(workspaceId) : null)
  const { scope: scopeParam } = useLocalSearchParams<{ scope?: string | string[] }>()
  // A card on the home screen may deep-link the inbox with an explicit scope
  // (e.g. the Failed resume card lands on All, since failed_resume rows are
  // not in the default open list). Applied only once the persisted filters
  // have hydrated, so it wins over storage but a later manual tab change -
  // or an app background/restore of this already-mounted screen - keeps the
  // operator's choice.
  useEffect(() => {
    if (!ready) return
    const wanted = inboxScopeFromParam(scopeParam)
    if (wanted) setScope(wanted)
  }, [ready, scopeParam, setScope])
  const [items, setItems] = useState<WorkItemRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const gateRef = useRef(createInboxRefreshGate())

  const refreshFromStart = useCallback(async () => {
    if (!client || !ready) return
    try {
      await gateRef.current.refresh(
        () => fetchInboxPage(client.inbox, { scope, q: q.trim() || undefined }),
        {
          setRefreshing,
          applyPage: (page) => {
            setItems(page.items)
            setNextCursor(page.nextCursor)
          },
        },
      )
      void refresh()
    } catch {
      setItems([])
      setNextCursor(null)
    }
  }, [client, q, ready, refresh, scope])

  const loadMore = useCallback(async () => {
    if (!client || !ready || !nextCursor || loadingMore || refreshing || gateRef.current.busy) return
    setLoadingMore(true)
    try {
      const data = await fetchInboxPage(client.inbox, { scope, q: q.trim() || undefined }, nextCursor)
      setItems((prev) => appendInboxItems(prev, data.items))
      setNextCursor(data.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }, [client, loadingMore, nextCursor, q, ready, refreshing, scope])

  useFocusEffect(
    useCallback(() => {
      void refreshFromStart()
    }, [refreshFromStart, screenEpoch]),
  )

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <View style={styles.headTitle}>
          <ScreenTitle>Inbox</ScreenTitle>
        </View>
        <Pressable
          onPress={() => void refreshFromStart()}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel="Refresh inbox"
          style={styles.refreshHit}
        >
          {refreshing ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Ionicons name="refresh" size={22} color={colors.text} />
          )}
        </Pressable>
      </View>
      <InboxScopeTabs value={scope} onChange={setScope} />
      <InboxSearch value={q} onChange={setQ} />
      <WorkItemList
        items={items}
        onOpen={(id) => router.push(`/inbox/${id}`)}
        hasMore={Boolean(nextCursor)}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
        refreshing={refreshing}
        onRefresh={() => void refreshFromStart()}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: colors.bg },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  headTitle: { flex: 1, marginRight: 8 },
  refreshHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: -6 },
})
