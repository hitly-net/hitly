import { Pressable, StyleSheet } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { colors } from '../../theme'

export function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Back" style={styles.hit}>
      <Ionicons name="chevron-back" size={28} color={colors.text} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  hit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
})
