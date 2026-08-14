import { Text, TextInput, StyleSheet, type KeyboardTypeOptions } from 'react-native'
import { colors } from '../../theme'

export function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  editable = true,
  multiline = false,
  keyboardType,
  secureTextEntry,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  editable?: boolean
  multiline?: boolean
  keyboardType?: KeyboardTypeOptions
  secureTextEntry?: boolean
}) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        editable={editable}
        multiline={multiline}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, multiline && styles.multiline, !editable && styles.disabled]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </>
  )
}

const styles = StyleSheet.create({
  label: { marginTop: 12, marginBottom: 6, fontSize: 13, color: colors.muted },
  input: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: colors.text,
    backgroundColor: colors.card,
  },
  multiline: { height: 88, paddingTop: 12, textAlignVertical: 'top' },
  disabled: { backgroundColor: colors.bg, color: colors.muted },
  hint: { marginTop: 6, fontSize: 12, color: colors.muted },
})
