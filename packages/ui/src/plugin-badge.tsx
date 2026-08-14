import type { PluginId } from '@hitly/core'
import { PluginMark, pluginBrand } from './plugin-brand'

export function PluginBadge({ plugin }: { plugin: PluginId }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <PluginMark plugin={plugin} />
      <span className="text-sm">{pluginBrand(plugin).label}</span>
    </span>
  )
}
