import { hermesPlugin } from '@hitly/plugin-hermes'
import { httpPlugin } from '@hitly/plugin-http'
import { langgraphPlugin } from '@hitly/plugin-langgraph'
import { mastraPlugin } from '@hitly/plugin-mastra'
import { temporalPlugin } from '@hitly/plugin-temporal'
import type { HitlyPlugin, PluginId } from '@hitly/core'

export const plugins: Record<PluginId, HitlyPlugin> = {
  mastra: mastraPlugin,
  http: httpPlugin,
  langgraph: langgraphPlugin,
  temporal: temporalPlugin,
  hermes: hermesPlugin,
}

export function getPlugin(id: PluginId): HitlyPlugin {
  return plugins[id]
}
