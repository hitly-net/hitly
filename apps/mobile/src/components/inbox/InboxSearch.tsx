import { TextInput, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function InboxSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="Search actions or projects"
      placeholderTextColor={colors.muted}
      style={styles.input}
      autoCapitalize="none"
      autoCorrect={false}
    />
  )
}

const styles = StyleSheet.create({
  input: {
    height: 40,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
    color: colors.text,
    backgroundColor: colors.card,
  },
})
