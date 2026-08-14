import { Modal, Pressable, Text, TextInput, View, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function EditArgsSheet({
  visible,
  value,
  onChange,
  onSubmit,
  onClose,
}: {
  visible: boolean
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onClose: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Text style={styles.title}>Edited args JSON</Text>
        <TextInput value={value} onChangeText={onChange} multiline style={styles.textarea} />
        <Pressable style={styles.button} onPress={onSubmit}>
          <Text style={styles.label}>Save edit</Text>
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
  textarea: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    color: colors.text,
  },
  button: { backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 8 },
  label: { color: colors.accentFg, fontWeight: '600', textAlign: 'center' },
  cancel: { marginTop: 12, textAlign: 'center', color: colors.muted },
})
