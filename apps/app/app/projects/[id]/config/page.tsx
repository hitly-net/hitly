import { and, eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { projectApiKeys, projectMemberships, users } from '@hitly/db/schema'
import { HitlyWordmark } from '@hitly/ui'
import { updateProjectConfig } from '@/actions/projects'
import { AppShell } from '@/components/app-shell'
import { ProjectApiKeys } from '@/components/project-api-keys'
import { ProjectResumeSecret } from '@/components/project-resume-secret'
import { ProjectTabs } from '@/components/project-tabs'
import { TestEvidenceSink } from '@/components/test-evidence-sink'
import { canAdminProject } from '@/lib/rbac'
import { requireVisibleProject } from '@/lib/project-page'
import { ensureProjectResumeSecret } from '@/lib/resume-secret'
import { resumeSecretPrefix } from '@/lib/keys'
import { requireDb, requireTenantWorkspaceId } from '@/lib/tenant'
import { withAppTenant } from '@/lib/context'
import { decodeTenantJson } from '@/lib/tenant-crypto'

export const metadata = { title: 'Config' }

export default async function ProjectConfigPage({ params }: { params: Promise<{ id: string }> }) {
  return withAppTenant(async () => {
  const { id } = await params
  const { project: loaded, access } = await requireVisibleProject(id)
  if (!canAdminProject(access)) redirect(`/projects/${id}`)
  const { project, resumeSecret } = await ensureProjectResumeSecret(loaded)

  const database = requireDb()
  const workspaceId = requireTenantWorkspaceId()
  const keys = await database
    .select()
    .from(projectApiKeys)
    .where(and(eq(projectApiKeys.projectId, id), eq(projectApiKeys.workspaceId, workspaceId)))
  const people = await database
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
    })
    .from(projectMemberships)
    .innerJoin(users, eq(projectMemberships.userId, users.id))
    .where(and(eq(projectMemberships.projectId, id), eq(projectMemberships.workspaceId, workspaceId)))

  const credentials = project.credentials as Record<string, unknown>
  const sinkConfig = project.evidenceSinkConfig ? await decodeTenantJson(project.workspaceId, project.evidenceSinkConfig as Record<string, unknown>) : {}
  const appUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

  return (
    <AppShell project={{ id: project.id, name: project.name }}>
      <h1 className="text-2xl font-semibold">{project.name}</h1>
      <ProjectTabs projectId={id} current="Config" />

      <form action={updateProjectConfig.bind(null, id)} className="mt-6 flex max-w-xl flex-col gap-3">
        <input
          name="name"
          defaultValue={project.name}
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <textarea
          name="description"
          defaultValue={project.description ?? ''}
          placeholder="Description"
          className="min-h-20 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          name="sla"
          defaultValue={project.defaultSlaMinutes}
          placeholder="Default SLA (minutes)"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <select
          name="defaultAssigneeUserId"
          defaultValue={project.defaultAssigneeUserId ?? ''}
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">No default assignee</option>
          {people.map((person) => (
            <option key={person.userId} value={person.userId}>
              {person.name} ({person.email})
            </option>
          ))}
        </select>
        <input
          name="baseUrl"
          defaultValue={String(credentials.baseUrl ?? credentials.deploymentUrl ?? '')}
          placeholder={project.plugin === 'temporal' ? 'Temporal address' : 'Origin base URL'}
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        {project.plugin === 'temporal' ? (
          <>
            <input
              name="address"
              defaultValue={String(credentials.address ?? '')}
              placeholder="Address"
              className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <input
              name="namespace"
              defaultValue={String(credentials.namespace ?? 'default')}
              placeholder="Namespace"
              className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <input
              name="taskQueue"
              defaultValue={String(credentials.taskQueue ?? '')}
              placeholder="Task queue"
              className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </>
        ) : (
          <input
            name="token"
            defaultValue=""
            placeholder="Mastra / origin HTTP token (leave blank to keep)"
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        )}

        <h3 className="mt-4 text-sm font-semibold">Evidence Storage</h3>
        <p className="text-xs text-zinc-500">
          Evidence is written to your URL. <HitlyWordmark className="text-xs font-normal" /> keeps a receipt only. Decide will not resume the origin if this URL fails.
        </p>
        <select
          name="evidenceSinkType"
          defaultValue={project.evidenceSinkType}
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="none">None</option>
          <option value="http">HTTP</option>
        </select>
        <input
          name="evidenceSinkUrl"
          defaultValue={String(sinkConfig.url ?? '')}
          placeholder="Evidence sink URL"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          name="evidenceSinkAuthHeader"
          type="password"
          defaultValue=""
          placeholder="Authorization header (leave blank to keep)"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <textarea
          name="evidenceSinkHeaders"
          defaultValue=""
          placeholder="Custom headers (one per line: Name: value)"
          className="min-h-20 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p className="text-xs text-zinc-500">
          Optional custom HTTP headers sent with each evidence POST. One per line like <code>X-Store-Token: abc123</code>. Transport-only, not stored in the evidence event.
        </p>
        <textarea
          name="evidenceSinkMetadata"
          defaultValue=""
          placeholder='Metadata JSON object: {"tenant":"acme","bucket":"audit"}'
          className="min-h-20 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <p className="text-xs text-zinc-500">
          Optional metadata JSON object sent as <code>X-Hitly-Metadata</code> header with each evidence POST. Transport-only, not stored in the evidence event.
        </p>

        <button
          type="submit"
          className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Save
        </button>
      </form>

      {project.evidenceSinkType === 'http' && typeof sinkConfig.url === 'string' && sinkConfig.url && (
        <div className="mt-3 max-w-xl">
          <TestEvidenceSink projectId={id} />
        </div>
      )}

      <h2 className="mt-10 text-lg font-semibold">API keys</h2>
      <p className="mt-1 text-sm text-zinc-500">Authenticate ingest. The secret is shown once when you create or regenerate a key.</p>
      <ProjectApiKeys
        projectId={id}
        keys={keys.map((key) => ({
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        }))}
      />

      <h2 className="mt-10 text-lg font-semibold">Resume secret</h2>
      <p className="mt-1 text-sm text-zinc-500">
        HITLY_RESUME_SECRET is independent of ingest API keys. Mastra verifies a signed proof on resume so a guessed
        runId cannot spoof an approval. Rotate if it leaks; update the origin .env and restart.
      </p>
      <ProjectResumeSecret projectId={id} secret={resumeSecret} />

      <h2 className="mt-10 text-lg font-semibold">Origin .env</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Paste into the origin. Reveal or copy the resume secret above; API keys are shown once when created.
      </p>
      <pre className="mt-3 max-w-xl overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">{`HITLY_API_URL=${appUrl}
HITLY_PROJECT_ID=${project.id}
HITLY_API_KEY=hitly_…
HITLY_RESUME_SECRET=${resumeSecretPrefix(resumeSecret)}…`}</pre>
    </AppShell>
  )
  })
}
