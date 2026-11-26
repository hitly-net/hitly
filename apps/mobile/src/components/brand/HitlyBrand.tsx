import { Image, Text, View, StyleSheet } from 'react-native'
import { colors } from '../../theme'

export function HitlyWordmark({
  size = 18,
  color = colors.text,
}: {
  size?: number
  color?: string
}) {
  return (
    <Text accessibilityLabel="HITLy" style={{ fontSize: size, fontWeight: '700', color, letterSpacing: -0.3 }}>
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

/** The current brand mark: H-and-check app icon as a rounded tile. */
export function HitlyBrandTile({ size = 48 }: { size?: number }) {
  return (
    <Image
      source={require('../../../assets/icons/app-icon.png')}
      style={{ width: size, height: size, borderRadius: size * 0.18 }}
      resizeMode="cover"
      accessibilityLabel="HITLy"
    />
  )
}

/** Square lockup: HUMAN / in the / LOOP. */
export function HitlyMark({ size = 72 }: { size?: number }) {
  return (
    <View
      accessibilityLabel="HITLy"
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
