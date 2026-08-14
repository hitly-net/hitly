import { Text, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function ArgsBlock({ args }: { args: Record<string, unknown> }) {
  return <Text style={styles.pre}>{JSON.stringify(args ?? {}, null, 2)}</Text>
}

const styles = StyleSheet.create({
  pre: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    fontSize: 12,
    fontFamily: 'Courier',
    color: colors.text,
  },
})
