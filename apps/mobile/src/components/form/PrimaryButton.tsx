import { Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, disabled && styles.disabled]}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  btn: {
    marginTop: 20,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.5 },
  label: { color: colors.accentFg, fontWeight: '600', fontSize: 15 },
})
