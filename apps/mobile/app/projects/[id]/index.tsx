import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View, StyleSheet } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { colors } from '../../../src/theme'
import { AuthGate } from '../../../src/auth-gate'
import { useSession } from '../../../src/providers/SessionProvider'
import { useAttention } from '../../../src/providers/AttentionProvider'
import { InboxScopeTabs } from '../../../src/components/inbox/InboxScopeTabs'
import { InboxSearch } from '../../../src/components/inbox/InboxSearch'
import { WorkItemList } from '../../../src/components/inbox/WorkItemList'
import { projectItemsFilterKey, useListFilters } from '../../../src/use-list-filters'
import type { ProjectRow, WorkItemRow } from '../../../src/types'

export default function ProjectScreen() {
  return (
    <AuthGate>
      <ProjectBody />
    </AuthGate>
  )
}

function ProjectBody() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { client } = useSession()
  const { screenEpoch } = useAttention()
  const router = useRouter()
  const [project, setProject] = useState<ProjectRow | null>(null)
  const { scope, setScope, q, setQ, ready } = useListFilters(id ? projectItemsFilterKey(id) : null)
  const [items, setItems] = useState<WorkItemRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!client || !id || !ready) return
    const [next, inbox] = await Promise.all([
      client.project(id),
      client.inbox({ scope, q: q.trim() || undefined, projectId: id }),
    ])
    setProject(next)
    setItems(inbox.items)
  }, [client, id, q, ready, scope])

  useFocusEffect(
    useCallback(() => {
      void load().catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
    }, [load, screenEpoch]),
  )

  if (!project && !error) return <ActivityIndicator style={styles.loader} />
  if (error && !project) return <Text style={styles.error}>{error}</Text>

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <Text style={styles.title}>{project?.name ?? 'Project'}</Text>
        {project?.canAdmin ? (
          <Pressable onPress={() => router.push(`/projects/${id}/config`)}>
            <Text style={styles.config}>Config</Text>
          </Pressable>
        ) : null}
      </View>
      <InboxScopeTabs value={scope} onChange={setScope} />
      <InboxSearch value={q} onChange={setQ} />
      <WorkItemList items={items} onOpen={(itemId) => router.push(`/inbox/${itemId}`)} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: colors.bg },
  loader: { marginTop: 48 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, flex: 1, marginRight: 12 },
  config: { fontSize: 15, fontWeight: '600', color: colors.text, textDecorationLine: 'underline' },
  error: { padding: 16, color: colors.danger },
})
