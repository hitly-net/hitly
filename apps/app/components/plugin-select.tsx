import { LISTED_PLUGIN_IDS } from '@hitly/core'
import { PLUGIN_BRANDS } from '@hitly/ui'

/** Plugin choice for a new project. Only listed plugins are offered. */
export function PluginSelect({ name = 'plugin', defaultValue = 'mastra' }: { name?: string; defaultValue?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-zinc-500">Plugin</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {LISTED_PLUGIN_IDS.map((plugin) => (
          <option key={plugin} value={plugin}>
            {PLUGIN_BRANDS[plugin].label}
            {plugin === 'http' ? ' — n8n, webhooks, custom callbacks' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
