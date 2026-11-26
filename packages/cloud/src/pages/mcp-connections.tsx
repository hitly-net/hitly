export type McpConnection = {
  clientName: string
  projectName: string
  createdAt: string | null
  lastUsedAt: string | null
}

export type McpConnectionsProps = {
  workspaceId: string
  connections: McpConnection[]
}

export function McpConnectionsSettings(_props: McpConnectionsProps) {
  return (
    <>
      <h1 className="text-2xl font-semibold">Integrations</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Self-hosted HITLy does not connect to agent marketplaces. Connect your agents directly
        with a project API key.
      </p>
    </>
  )
}
