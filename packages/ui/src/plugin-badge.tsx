import type { PluginId } from '@hitly/core'
import { Badge } from './badge'

const LABELS: Record<PluginId, string> = {
  mastra: 'Mastra',
  n8n: 'n8n',
  langgraph: 'LangGraph',
  temporal: 'Temporal',
}

export function PluginBadge({ plugin }: { plugin: PluginId }) {
  return <Badge variant="secondary">{LABELS[plugin]}</Badge>
}
