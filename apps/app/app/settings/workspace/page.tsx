import { updateWorkspace } from '@/actions/workspace'
import { addOtelEndpoint, deleteOtelEndpoint, listOtelEndpoints, toggleOtelEndpoint } from '@/actions/otel'
import { AppShell } from '@/components/app-shell'
import { getAppContext, getWorkspaceRecord } from '@/lib/context'
import { canManageWorkspace } from '@/lib/rbac'

export const metadata = { title: 'Workspace' }

export default async function WorkspacePage() {
  const { workspace, role } = await getAppContext()
  const record = await getWorkspaceRecord(workspace.id)
  const admin = canManageWorkspace(role)
  const endpoints = await listOtelEndpoints()

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Workspace</h1>
      <p className="mt-2 text-sm text-zinc-500">Name, timezone, and the default SLA for work items in this workspace.</p>
      <form action={updateWorkspace} className="mt-6 flex max-w-md flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-500">Name</span>
          <input
            name="name"
            defaultValue={record?.name ?? workspace.name}
            disabled={!admin}
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">Shown in the header switcher and team settings.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-500">Timezone</span>
          <input
            name="timezone"
            defaultValue={record?.timezone ?? 'UTC'}
            disabled={!admin}
            placeholder="UTC"
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">IANA timezone for displaying times, for example UTC or Europe/London.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-zinc-500">Default SLA (minutes)</span>
          <input
            name="sla"
            defaultValue={record?.defaultSlaMinutes ?? '60'}
            disabled={!admin}
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500">
            How long a work item stays open before it expires. Projects can override this.
          </span>
        </label>
        {admin ? (
          <button
            type="submit"
            className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Save
          </button>
        ) : (
          <p className="text-sm text-zinc-500">Only workspace admins can edit these settings.</p>
        )}
      </form>

      <div className="mt-12">
        <h2 className="text-xl font-semibold">OTEL Endpoints</h2>
        <p className="mt-2 text-sm text-zinc-500">
          Export approval lifecycle traces to OpenTelemetry collectors. See <a href="/docs/trace" className="underline">docs</a>.
        </p>

        {endpoints.length > 0 && (
          <div className="mt-4 space-y-2">
            {endpoints.map((endpoint) => (
              <div key={endpoint.id} className="flex items-center justify-between rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{endpoint.name}</span>
                    {endpoint.enabled ? (
                      <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900 dark:text-green-100">
                        Enabled
                      </span>
                    ) : (
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">{endpoint.endpoint}</p>
                  <p className="text-xs text-zinc-400">{endpoint.protocol}</p>
                </div>
                {admin && (
                  <div className="flex gap-2">
                    <form action={toggleOtelEndpoint.bind(null, endpoint.id)}>
                      <button
                        type="submit"
                        className="rounded-md border border-zinc-200 px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        {endpoint.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </form>
                    <form action={deleteOtelEndpoint.bind(null, endpoint.id)}>
                      <button
                        type="submit"
                        className="rounded-md border border-red-200 px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {admin && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Add OTEL Endpoint
            </summary>
            <form action={addOtelEndpoint} className="mt-4 flex max-w-md flex-col gap-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-700">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-500">Name</span>
                <input
                  name="name"
                  required
                  placeholder="Phoenix"
                  className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-500">Endpoint</span>
                <input
                  name="endpoint"
                  required
                  placeholder="http://127.0.0.1:6006/v1/traces"
                  className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                <span className="text-xs text-zinc-500">OTLP/HTTP traces URL</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-500">Protocol</span>
                <select
                  name="protocol"
                  defaultValue="http/protobuf"
                  className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="http/protobuf">http/protobuf</option>
                  <option value="http/json">http/json</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-zinc-500">Headers (optional)</span>
                <textarea
                  name="headers"
                  placeholder="Authorization: Bearer token&#10;X-Custom-Header: value"
                  rows={3}
                  className="rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                <span className="text-xs text-zinc-500">One per line: Name: value. Stored encrypted.</span>
              </label>
              <button
                type="submit"
                className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Add Endpoint
              </button>
            </form>
          </details>
        )}
      </div>
    </AppShell>
  )
}
