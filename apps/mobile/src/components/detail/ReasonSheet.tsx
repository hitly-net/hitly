import { Modal, Pressable, Text, TextInput, View, StyleSheet } from 'react-native'
import { colors } from '../../theme'

/**
 * Reason prompt for answers that list `reasonRequired` (hitl-spec 3.6).
 * Submit is disabled while the reason is blank after trimming; the typed string is
 * sent as `reason` on the decide payload, so the host re-validation accepts it.
 */
export function ReasonSheet({
  visible,
  decision,
  value,
  onChange,
  onSubmit,
  onClose,
}: {
  visible: boolean
  decision?: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onClose: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Text style={styles.title}>{decision ? `Reason for ${decision}` : 'Reason'}</Text>
        <TextInput
          value={value}
          onChangeText={onChange}
          multiline
          numberOfLines={3}
          style={styles.input}
          placeholder="Why are you answering this way?"
        />
        <Pressable style={styles.button} onPress={onSubmit} disabled={!value.trim()}>
          <Text style={styles.label}>Send</Text>
        </Pressable>
        <Pressable onPress={onClose}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  sheet: {
    marginTop: 'auto',
    backgroundColor: colors.card,
    padding: 24,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12, color: colors.text },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    marginBottom: 12,
    textAlignVertical: 'top',
    color: colors.text,
  },
  button: { backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 8, opacity: 1 },
  label: { color: colors.accentFg, fontWeight: '600', textAlign: 'center' },
  cancel: { marginTop: 12, textAlign: 'center', color: colors.muted },
})
