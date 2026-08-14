import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View, StyleSheet } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { colors } from '../../../src/theme'
import { AuthGate } from '../../../src/auth-gate'
import { useSession } from '../../../src/providers/SessionProvider'
import { Field } from '../../../src/components/form/Field'
import { PrimaryButton } from '../../../src/components/form/PrimaryButton'
import { ScreenTitle } from '../../../src/components/nav/ScreenTitle'
import type { ProjectConfig } from '../../../src/types'

export default function ProjectConfigScreen() {
  return (
    <AuthGate>
      <ProjectConfigBody />
    </AuthGate>
  )
}

function ProjectConfigBody() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { client } = useSession()
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sla, setSla] = useState('60')
  const [assignee, setAssignee] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [address, setAddress] = useState('')
  const [namespace, setNamespace] = useState('')
  const [taskQueue, setTaskQueue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!client || !id) return
    let cancelled = false
    void client
      .projectConfig(id)
      .then((next) => {
        if (cancelled) return
        setConfig(next)
        setName(next.name)
        setDescription(next.description)
        setSla(next.defaultSlaMinutes)
        setAssignee(next.defaultAssigneeUserId ?? '')
        setBaseUrl(next.baseUrl)
        setAddress(next.address)
        setNamespace(next.namespace)
        setTaskQueue(next.taskQueue)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [client, id])

  async function save() {
    if (!client || !id) return
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      await client.updateProjectConfig(id, {
        name,
        description,
        sla,
        defaultAssigneeUserId: assignee || null,
        baseUrl,
        token: token || undefined,
        address,
        namespace,
        taskQueue,
      })
      setToken('')
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setPending(false)
    }
  }

  if (!config && !error) return <ActivityIndicator style={styles.loader} />
  if (error && !config) return <Text style={styles.error}>{error}</Text>
  if (!config) return null

  const temporal = config.plugin === 'temporal'

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <ScreenTitle>Config</ScreenTitle>
      <Text style={styles.lede}>Name, SLA, default assignee, and origin connection. API keys stay on the web app.</Text>
      <Field label="Name" value={name} onChange={setName} />
      <Field label="Description" value={description} onChange={setDescription} multiline />
      <Field label="Default SLA (minutes)" value={sla} onChange={setSla} keyboardType="number-pad" />
      <Text style={styles.label}>Default assignee</Text>
      <Pressable onPress={() => setAssignee('')} style={[styles.chip, !assignee && styles.chipActive]}>
        <Text style={[styles.chipLabel, !assignee && styles.chipLabelActive]}>None</Text>
      </Pressable>
      {config.people.map((person) => {
        const active = assignee === person.userId
        return (
          <Pressable
            key={person.userId}
            onPress={() => setAssignee(person.userId)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
              {person.name ? `${person.name} (${person.email})` : person.email}
            </Text>
          </Pressable>
        )
      })}
      <Field
        label={temporal ? 'Temporal address' : 'Origin base URL'}
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder={temporal ? 'Temporal address' : 'https://…'}
      />
      {temporal ? (
        <>
          <Field label="Address" value={address} onChange={setAddress} />
          <Field label="Namespace" value={namespace} onChange={setNamespace} />
          <Field label="Task queue" value={taskQueue} onChange={setTaskQueue} />
        </>
      ) : (
        <Field
          label="Origin HTTP token"
          value={token}
          onChange={setToken}
          secureTextEntry
          placeholder="Leave blank to keep the current token"
        />
      )}
      <PrimaryButton label={pending ? 'Saving…' : 'Save'} onPress={() => void save()} disabled={pending} />
      {saved ? <Text style={styles.ok}>Saved.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={{ height: 24 }} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 16, backgroundColor: colors.bg, flexGrow: 1, paddingBottom: 48 },
  loader: { marginTop: 48 },
  lede: { fontSize: 14, color: colors.muted, marginBottom: 8 },
  label: { marginTop: 12, marginBottom: 6, fontSize: 13, color: colors.muted },
  chip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipLabel: { fontSize: 13, color: colors.text },
  chipLabelActive: { color: colors.accentFg },
  ok: { marginTop: 12, fontSize: 13, color: colors.success },
  error: { marginTop: 12, paddingHorizontal: 16, fontSize: 13, color: colors.danger },
})
