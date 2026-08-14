import { View, Text, StyleSheet } from 'react-native'
import type { PluginId } from '@hitly/core'

const BRANDS: Record<string, { label: string; bg: string; fg: string }> = {
  mastra: { label: 'Mastra', bg: '#111111', fg: '#F4F1EA' },
  n8n: { label: 'n8n', bg: '#EA4B71', fg: '#FFFFFF' },
  langgraph: { label: 'LangGraph', bg: '#1C3C3C', fg: '#FFFFFF' },
  temporal: { label: 'Temporal', bg: '#000000', fg: '#FFFFFF' },
}

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
