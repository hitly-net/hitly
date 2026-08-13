import { langgraphPlugin } from '@hitly/plugin-langgraph'
import { mastraPlugin } from '@hitly/plugin-mastra'
import { n8nPlugin } from '@hitly/plugin-n8n'
import { temporalPlugin } from '@hitly/plugin-temporal'
import type { HitlyPlugin, PluginId } from '@hitly/core'

export const plugins: Record<PluginId, HitlyPlugin> = {
  mastra: mastraPlugin,
  n8n: n8nPlugin,
  langgraph: langgraphPlugin,
  temporal: temporalPlugin,
}

export function getPlugin(id: PluginId): HitlyPlugin {
  return plugins[id]
}
