import { Text, View, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function HitlyWordmark({
  size = 18,
  color = colors.text,
}: {
  size?: number
  color?: string
}) {
  return (
    <Text accessibilityLabel="Hitly" style={{ fontSize: size, fontWeight: '700', color, letterSpacing: -0.3 }}>
      HITL
      <Text
        style={{
          fontSize: size * 0.62,
          fontStyle: 'italic',
          fontWeight: '700',
          lineHeight: size * 0.7,
          transform: [{ translateY: size * 0.12 }],
        }}
      >
        y
      </Text>
    </Text>
  )
}

export function HitlyH({ size = 28 }: { size?: number }) {
  const bar = size * 0.11
  const inset = size * 0.26
  return (
    <View
      accessibilityLabel="Hitly"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        backgroundColor: colors.accent,
        justifyContent: 'center',
      }}
    >
      <View style={{ position: 'absolute', left: inset, top: size * 0.22, width: bar, height: size * 0.56, backgroundColor: colors.accentFg }} />
      <View style={{ position: 'absolute', right: inset, top: size * 0.22, width: bar, height: size * 0.56, backgroundColor: colors.accentFg }} />
      <View style={{ position: 'absolute', left: inset, top: size * 0.445, width: size - inset * 2, height: bar, backgroundColor: colors.accentFg }} />
    </View>
  )
}

/** Square lockup: HUMAN / in the / LOOP. */
export function HitlyMark({ size = 72 }: { size?: number }) {
  return (
    <View
      accessibilityLabel="Hitly"
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: size * 0.18,
          paddingHorizontal: size * 0.08,
        },
      ]}
    >
      <Text
        style={{
          color: colors.accentFg,
          fontSize: size * 0.175,
          fontWeight: '800',
          letterSpacing: size * -0.012,
          textAlign: 'center',
          includeFontPadding: false,
        }}
      >
        HUMAN
      </Text>
      <Text
        style={{
          color: colors.accentFg,
          fontSize: size * 0.12,
          fontStyle: 'italic',
          fontWeight: '500',
          textAlign: 'center',
          marginVertical: size * 0.03,
          includeFontPadding: false,
        }}
      >
        in the
      </Text>
      <Text
        style={{
          color: colors.accentFg,
          fontSize: size * 0.24,
          fontWeight: '800',
          letterSpacing: size * 0.01,
          textAlign: 'center',
          includeFontPadding: false,
        }}
      >
        LOOP
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  mark: {
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
