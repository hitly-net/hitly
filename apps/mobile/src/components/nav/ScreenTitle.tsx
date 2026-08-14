import { Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function ScreenTitle({ children }: { children: string }) {
  return <Text style={styles.title}>{children}</Text>
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 8 },
})
