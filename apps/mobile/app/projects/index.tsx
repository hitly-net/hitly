import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View, StyleSheet } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { colors } from '../../src/theme'
import { AuthGate } from '../../src/auth-gate'
import { useSession } from '../../src/providers/SessionProvider'
import { useAttention } from '../../src/providers/AttentionProvider'
import { PluginMark } from '../../src/components/inbox/PluginMark'
import { ScreenTitle } from '../../src/components/nav/ScreenTitle'
import type { ProjectRow } from '../../src/types'

export default function ProjectsScreen() {
  return (
    <AuthGate>
      <ProjectsBody />
    </AuthGate>
  )
}

function ProjectsBody() {
  const { client } = useSession()
  const { screenEpoch } = useAttention()
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useFocusEffect(
    useCallback(() => {
      if (!client) return
      let cancelled = false
      void client
        .projects()
        .then((data) => {
          if (!cancelled) setProjects(data.projects)
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
        })
      return () => {
        cancelled = true
      }
    }, [client, screenEpoch]),
  )

  if (!projects && !error) return <ActivityIndicator style={styles.loader} />

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <ScreenTitle>Projects</ScreenTitle>
      <Text style={styles.lede}>Work items and origin config for each project.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {projects?.length === 0 ? <Text style={styles.empty}>No projects in this workspace.</Text> : null}
      {projects?.map((project) => (
        <Pressable key={project.id} onPress={() => router.push(`/projects/${project.id}`)} style={styles.row}>
          <PluginMark plugin={project.plugin} />
          <View style={styles.body}>
            <Text style={styles.title}>{project.name}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {project.description || project.plugin}
            </Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 16, backgroundColor: colors.bg, flexGrow: 1, paddingBottom: 48 },
  loader: { marginTop: 48 },
  lede: { fontSize: 14, color: colors.muted, marginBottom: 16 },
  empty: { marginTop: 24, color: colors.muted, textAlign: 'center' },
  error: { color: colors.danger, marginBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  meta: { marginTop: 2, fontSize: 12, color: colors.muted },
})
