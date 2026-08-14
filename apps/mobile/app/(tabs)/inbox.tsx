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
import type { WorkItemRow } from '../../src/types'

export default function InboxListScreen() {
  const { client, workspaceId } = useSession()
  const { screenEpoch } = useAttention()
  const router = useRouter()
  const { scope, setScope, q, setQ, ready } = useListFilters(workspaceId ? inboxFilterKey(workspaceId) : null)
  const [items, setItems] = useState<WorkItemRow[]>([])

  const load = useCallback(async () => {
    if (!client || !ready) return
    const data = await client.inbox({ scope, q: q.trim() || undefined })
    setItems(data.items)
  }, [client, q, ready, scope])

  useFocusEffect(
    useCallback(() => {
      void load().catch(() => setItems([]))
    }, [load, screenEpoch]),
  )

  return (
    <View style={styles.screen}>
      <ScreenTitle>Inbox</ScreenTitle>
      <InboxScopeTabs value={scope} onChange={setScope} />
      <InboxSearch value={q} onChange={setQ} />
      <WorkItemList items={items} onOpen={(id) => router.push(`/inbox/${id}`)} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: colors.bg },
})
