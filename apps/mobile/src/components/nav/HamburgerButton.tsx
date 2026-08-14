import { Pressable, View, StyleSheet } from 'react-native'
import { colors } from '../../theme'
import { useMenu } from '../../providers/MenuProvider'

export function HamburgerButton() {
  const { show } = useMenu()
  return (
    <Pressable onPress={show} accessibilityRole="button" accessibilityLabel="Open menu" style={styles.hit}>
      <View style={styles.line} />
      <View style={styles.line} />
      <View style={styles.line} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  hit: { width: 44, height: 44, justifyContent: 'center', paddingHorizontal: 10, gap: 5 },
  line: { height: 2, borderRadius: 1, backgroundColor: colors.text },
})
