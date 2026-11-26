import { AppShell } from '@/components/app-shell'
import { McpConnectionsSettings } from '@hitly/cloud/pages/mcp-connections'
import { listConnections } from '@hitly/cloud/mcp-oauth/routes'
import { getAppContext } from '@/lib/context'

export const metadata = { title: 'Integrations' }

export default async function IntegrationsPage() {
  const { workspace } = await getAppContext()
  const connections = await listConnections(workspace.id)

  return (
    <AppShell>
      <McpConnectionsSettings workspaceId={workspace.id} connections={connections} />
    </AppShell>
  )
}
