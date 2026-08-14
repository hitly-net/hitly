import { useEffect, useState } from 'react'
import { ActivityIndicator, ScrollView, Text, StyleSheet } from 'react-native'
import { colors } from '../src/theme'
import { AuthGate } from '../src/auth-gate'
import { useSession } from '../src/providers/SessionProvider'
import { useAttention } from '../src/providers/AttentionProvider'
import { WorkspacePicker } from '../src/components/nav/WorkspacePicker'
import { ScreenTitle } from '../src/components/nav/ScreenTitle'
import { Field } from '../src/components/form/Field'
import { PrimaryButton } from '../src/components/form/PrimaryButton'
import type { WorkspaceSettings } from '../src/types'

export default function WorkspaceScreen() {
  return (
    <AuthGate>
      <WorkspaceBody />
    </AuthGate>
  )
}

function WorkspaceBody() {
  const { client, refreshWorkspaces, workspaceId } = useSession()
  const { screenEpoch } = useAttention()
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState('UTC')
  const [sla, setSla] = useState('60')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void client
      .workspace()
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        setName(next.name)
        setTimezone(next.timezone)
        setSla(next.defaultSlaMinutes)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [client, screenEpoch, workspaceId])

  async function save() {
    if (!client) return
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      const next = await client.updateWorkspace({ name, timezone, sla })
      setSettings(next)
      await refreshWorkspaces()
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setPending(false)
    }
  }

  if (!settings && !error) return <ActivityIndicator style={styles.loader} />

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <ScreenTitle>Workspace</ScreenTitle>
      <Text style={styles.lede}>Switch workspace, or edit name, timezone, and default SLA.</Text>
      <WorkspacePicker />
      {settings ? (
        <>
          <Field label="Name" value={name} onChange={setName} editable={settings.canManage} />
          <Field
            label="Timezone"
            value={timezone}
            onChange={setTimezone}
            editable={settings.canManage}
            hint="IANA timezone, for example UTC or Europe/London."
          />
          <Field
            label="Default SLA (minutes)"
            value={sla}
            onChange={setSla}
            editable={settings.canManage}
            keyboardType="number-pad"
            hint="How long a work item stays open before it expires. Projects can override this."
          />
          {settings.canManage ? (
            <PrimaryButton label={pending ? 'Saving…' : 'Save'} onPress={() => void save()} disabled={pending} />
          ) : (
            <Text style={styles.hint}>Only workspace admins can edit these settings.</Text>
          )}
        </>
      ) : null}
      {saved ? <Text style={styles.ok}>Saved.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 16, backgroundColor: colors.bg, flexGrow: 1, paddingBottom: 48 },
  loader: { marginTop: 48 },
  lede: { fontSize: 14, color: colors.muted, marginBottom: 16 },
  hint: { marginTop: 16, fontSize: 13, color: colors.muted },
  ok: { marginTop: 12, fontSize: 13, color: colors.success },
  error: { marginTop: 12, fontSize: 13, color: colors.danger },
})
