import Link from 'next/link'
import { notFound } from 'next/navigation'
import { desc, eq } from 'drizzle-orm'
import { isOpenApprovalStatus, type ApprovalEnvelope, type Decision, type OriginRef, type PluginId } from '@hitly/core'
import { approvals, decisionRecords, projectMemberships, users } from '@hitly/db/schema'
import { Badge, PluginBadge, PluginMark } from '@hitly/ui'
import { decideWorkItem, delegateWorkItem, retryWorkItem } from '@/actions/projects'
import { AppShell } from '@/components/app-shell'
import { ContextMarkdown } from '@/components/context-markdown'
import { ForceCancelButton } from '@/components/force-cancel-button'
import { JsonDisclosure } from '@/components/json-disclosure'
import { getAppContext } from '@/lib/context'
import { originFields, envelopeMetadata } from '@/lib/origin'
import { canDecide, getProjectAccess } from '@/lib/rbac'
import { requireDb } from '@/lib/require-db'
import { approvalHasExpired } from '@/lib/approval-expiry'

function personLabel(person: { name: string | null; email: string }) {
  return person.name ? `${person.name} (${person.email})` : person.email
}

export async function WorkItemDetail({
  approvalId,
  projectId,
}: {
  approvalId: string
  projectId?: string
}) {
  const { user, role, workspace } = await getAppContext()
  const database = requireDb()
  const rows = await database.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  const approval = rows[0]
  if (!approval || approval.workspaceId !== workspace.id) notFound()
  if (projectId && approval.projectId !== projectId) notFound()

  const access = await getProjectAccess({
    projectId: approval.projectId,
    userId: user.id,
    workspaceRole: role,
  })
  if (!access) notFound()

  const project = access.project
  const people = await database
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: projectMemberships.role,
    })
    .from(projectMemberships)
    .innerJoin(users, eq(projectMemberships.userId, users.id))
    .where(eq(projectMemberships.projectId, approval.projectId))

  const assignedRows = approval.assignedUserId
    ? await database
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, approval.assignedUserId))
        .limit(1)
    : []
  const assigned = assignedRows[0]
  const defaultAssignee = people.find((person) => person.userId === project.defaultAssigneeUserId)

  const decisions = await database
    .select()
    .from(decisionRecords)
    .where(eq(decisionRecords.approvalId, approval.id))
    .orderBy(desc(decisionRecords.createdAt))
  const latestDecision = decisions[0]

  const envelope = approval.envelope as unknown as ApprovalEnvelope
  const origin = approval.origin as unknown as OriginRef
  const originRows = originFields(origin)
  const metadata = envelopeMetadata(envelope, origin)
  const allowed = envelope.allowedActions
  const canAct = canDecide(access) && isOpenApprovalStatus(approval.status)
  const expired = approvalHasExpired(approval)
  const canCancel = canDecide(access) && isOpenApprovalStatus(approval.status)
  const delegateTargets = people.filter(
    (person) => person.role !== 'reader' && person.userId !== approval.assignedUserId,
  )
  const canDelegate = canAct && !expired && people.length > 1 && delegateTargets.length > 0
  const inProject = Boolean(projectId)
  const returnTo = inProject
    ? `/projects/${approval.projectId}/item/${approval.id}`
    : `/inbox/${approval.id}`

  return (
    <AppShell project={{ id: project.id, name: project.name }}>
      <div className="flex flex-wrap items-center gap-2">
        <PluginMark plugin={approval.plugin as PluginId} size="md" className="h-8 w-8" />
        <Badge
          variant={
            approval.status === 'pending'
              ? 'warning'
              : approval.status === 'failed_resume'
                ? 'warning'
                : approval.status === 'decided'
                  ? 'success'
                  : 'secondary'
          }
        >
          {approval.status}
        </Badge>
      </div>
      <div className="mt-4 flex max-w-2xl items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold">{approval.actionName}</h1>
        {canCancel ? <ForceCancelButton approvalId={approval.id} /> : null}
      </div>
      {originRows.length > 0 ? (
        <section className="mt-6 max-w-2xl rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Origin</h2>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            {originRows.map((row) => (
              <p key={row.key} className={row.key === 'runId' || row.key === 'toolCallId' ? 'sm:col-span-2' : undefined}>
                <span className="text-zinc-500">{row.label}</span>
                <br />
                <span className="break-all font-mono text-xs">{row.value}</span>
              </p>
            ))}
          </div>
        </section>
      ) : null}
      <details className="mt-6 max-w-2xl rounded-md border border-zinc-200 dark:border-zinc-800">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
          Project · {project.name}
        </summary>
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <p>
              <span className="text-zinc-500">Name</span>
              <br />
              <Link href={`/projects/${project.id}`} className="underline">
                {project.name}
              </Link>
            </p>
            <div>
              <span className="text-zinc-500">Plugin</span>
              <br />
              <PluginBadge plugin={project.plugin as PluginId} />
            </div>
            <p className="sm:col-span-2">
              <span className="text-zinc-500">Description</span>
              <br />
              {project.description || 'No description.'}
            </p>
            <p>
              <span className="text-zinc-500">Default SLA</span>
              <br />
              {project.defaultSlaMinutes} minutes
            </p>
            <p>
              <span className="text-zinc-500">Assigned to</span>
              <br />
              {assigned ? personLabel(assigned) : 'Unassigned'}
            </p>
            <p>
              <span className="text-zinc-500">Default assignee</span>
              <br />
              {defaultAssignee ? personLabel(defaultAssignee) : 'None'}
            </p>
            <p className="sm:col-span-2">
              <span className="text-zinc-500">People</span>
              <br />
              {people.length === 0
                ? 'No project members.'
                : people.map((person) => `${personLabel(person)} · ${person.role}`).join(', ')}
            </p>
          </div>
          {canDelegate ? (
            <form action={delegateWorkItem.bind(null, approval.id)} className="mt-4 flex max-w-xl gap-2">
              <input type="hidden" name="returnTo" value={returnTo} />
              <select
                name="userId"
                required
                className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Delegate to…</option>
                {delegateTargets.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {personLabel(person)}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Delegate
              </button>
            </form>
          ) : null}
        </div>
      </details>
      <ContextMarkdown
        value={envelope.contextMarkdown}
        externalUrls={envelope.externalUrls}
        attachments={envelope.attachments}
      />
      <pre className="mt-4 max-w-2xl overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        {JSON.stringify(envelope.action.args ?? {}, null, 2)}
      </pre>
      <JsonDisclosure
        value={{
          action: envelope.action,
          allowedActions: envelope.allowedActions,
          contextMarkdown: envelope.contextMarkdown,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          externalUrls: envelope.externalUrls,
          attachments: envelope.attachments,
          resumeSchema: envelope.resumeSchema,
          expiresAt: envelope.expiresAt,
          origin: approval.origin,
        }}
      />
      {latestDecision ? (
        <section className="mt-8 max-w-2xl">
          <h2 className="text-sm font-semibold">Decision</h2>
          <p className="mt-1 text-sm capitalize text-zinc-600 dark:text-zinc-400">
            {latestDecision.decision}
            {latestDecision.resumeError ? ' · resume failed' : ''}
          </p>
          {latestDecision.resumeError ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{latestDecision.resumeError}</p>
          ) : null}
          <h2 className="mt-6 text-sm font-semibold">Origin response</h2>
          <p className="mt-1 text-xs text-zinc-500">Full payload returned to the origin after this decision.</p>
          <pre className="mt-2 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            {JSON.stringify(latestDecision.resumeResponse ?? latestDecision.payload, null, 2)}
          </pre>
        </section>
      ) : null}
      {expired && approval.status === 'pending' ? (
        <p className="mt-4 text-sm text-amber-700">This work item has expired.</p>
      ) : null}
      {canAct && !expired ? (
        <form action={decideWorkItem.bind(null, approval.id)} className="mt-6 flex max-w-xl flex-col gap-3">
          <input type="hidden" name="returnTo" value={returnTo} />
          {allowed.edit ? (
            <textarea
              name="editedArgs"
              placeholder='Edited args JSON, e.g. {"amount": 10}'
              className="min-h-20 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          ) : null}
          {allowed.respond ? (
            <input
              name="response"
              placeholder="Response"
              className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(Object.entries(allowed) as [Decision, boolean][])
              .filter(([, on]) => on)
              .map(([decision]) => (
                <button
                  key={decision}
                  name="decision"
                  value={decision}
                  className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium capitalize text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  {decision}
                </button>
              ))}
          </div>
        </form>
      ) : null}
      {approval.status === 'failed_resume' && canDecide(access) ? (
        <form action={retryWorkItem.bind(null, approval.id)} className="mt-4">
          <button type="submit" className="text-sm underline">
            Retry resume
          </button>
        </form>
      ) : null}
    </AppShell>
  )
}
