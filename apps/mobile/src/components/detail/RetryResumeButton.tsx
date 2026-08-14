import { Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function RetryResumeButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.btn}>
      <Text style={styles.label}>Retry resume</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  btn: { marginTop: 12 },
  label: { fontSize: 14, color: colors.text, textDecorationLine: 'underline' },
})
