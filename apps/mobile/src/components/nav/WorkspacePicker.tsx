import { Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'
import { useSession } from '../../providers/SessionProvider'

export function WorkspacePicker() {
  const { workspaces, workspaceId, setWorkspace } = useSession()
  if (workspaces.length < 2) {
    const current = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0]
    return current ? <Text style={styles.single}>{current.name}</Text> : null
  }
  return (
    <>
      {workspaces.map((workspace) => (
        <Pressable
          key={workspace.id}
          onPress={() => void setWorkspace(workspace.id)}
          style={[styles.chip, workspace.id === workspaceId && styles.active]}
        >
          <Text style={[styles.label, workspace.id === workspaceId && styles.activeLabel]}>{workspace.name}</Text>
        </Pressable>
      ))}
    </>
  )
}

const styles = StyleSheet.create({
  single: { fontSize: 13, color: colors.muted, marginBottom: 12 },
  chip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 12,
  },
  active: { backgroundColor: colors.accent, borderColor: colors.accent },
  label: { fontSize: 13, color: colors.text },
  activeLabel: { color: colors.accentFg },
})
