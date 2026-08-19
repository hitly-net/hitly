import { View, Text, StyleSheet } from 'react-native'
import type { PluginId } from '@hitly/core'
import { BRANDS } from './PluginMark.brands'

export { BRANDS }

export function PluginMark({ plugin }: { plugin: PluginId | string }) {
  const brand = BRANDS[plugin] ?? { label: plugin, bg: '#18181b', fg: '#fafafa' }
  return (
    <View style={[styles.box, { backgroundColor: brand.bg }]} accessibilityLabel={brand.label}>
      <Text style={[styles.glyph, { color: brand.fg }]}>{brand.label.slice(0, 1)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    width: 32,
    height: 32,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 14, fontWeight: '700' },
})
