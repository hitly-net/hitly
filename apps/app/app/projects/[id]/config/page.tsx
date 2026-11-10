import { and, eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { projectApiKeys, projectMemberships, users } from '@hitly/db/schema'
import { ProjectConfigForm } from '@/components/project-config-form'
import { AppShell } from '@/components/app-shell'
import { ProjectApiKeys } from '@/components/project-api-keys'
import { ProjectResumeSecret } from '@/components/project-resume-secret'
import { ProjectTabs } from '@/components/project-tabs'
import { TestEvidenceSink } from '@/components/test-evidence-sink'
import { canAdminProject } from '@/lib/rbac'
import { requireVisibleProject } from '@/lib/project-page'
import { publicOriginFields } from '@/lib/project-config'
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

      <ProjectConfigForm
        projectId={id}
        plugin={project.plugin}
        name={project.name}
        description={project.description ?? ''}
        defaultSlaMinutes={project.defaultSlaMinutes}
        defaultAssigneeUserId={project.defaultAssigneeUserId}
        people={people.map((person) => ({
          userId: person.userId,
          name: person.name ?? person.email,
          email: person.email,
        }))}
        origin={publicOriginFields(project.plugin, credentials)}
        evidenceSinkType={
          project.evidenceSinkType === 'http' || project.evidenceSinkType === 's3' ? project.evidenceSinkType : 'none'
        }
        sink={{
          url: String(sinkConfig.url ?? ''),
          endpoint: String(sinkConfig.endpoint ?? ''),
          region: String(sinkConfig.region ?? ''),
          bucket: String(sinkConfig.bucket ?? ''),
          prefix: String(sinkConfig.prefix ?? ''),
          forcePathStyle:
            typeof sinkConfig.forcePathStyle === 'boolean' ? sinkConfig.forcePathStyle : undefined,
        }}
      />

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
