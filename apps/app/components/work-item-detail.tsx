import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { PluginId } from '@hitly/core'
import { Badge, PluginBadge, PluginMark } from '@hitly/ui'
import { decideWorkItem, delegateWorkItem, retryWorkItem } from '@/actions/projects'
import { AppShell } from '@/components/app-shell'
import { ContextMarkdown } from '@/components/context-markdown'
import { AnswerForm } from '@/components/answer-form'
import { ForceCancelButton } from '@/components/force-cancel-button'
import { JsonDisclosure } from '@/components/json-disclosure'
import { MarkPresentedIfCanAct, RefreshOnFocus } from '@/components/work-item-client'
import { EditedArgsPanel } from '@/components/edited-args-panel'
import { OriginalRequestPanel } from '@/components/original-request-panel'
import { withAppTenant } from '@/lib/context'
import { formatStatusLabel } from '@/lib/status-label'
import { redactedRequestJson } from '@/lib/redact-request-payload'
import {
  loadWorkItemPage,
  workItemClientFlightProps,
  type WorkItemPageDto,
  type WorkItemPerson,
} from '@/lib/work-item-page'

function personLabel(person: { name: string | null; email: string }) {
  return person.name ? `${person.name} (${person.email})` : person.email
}

export async function WorkItemDetail({
  approvalId,
  projectId,
  errorMessage,
}: {
  approvalId: string
  projectId?: string
  errorMessage?: string
}) {
  return withAppTenant(async ({ user, role, workspace }) => {
    const page = await loadWorkItemPage({
      approvalId,
      projectId,
      userId: user.id,
      workspaceId: workspace.id,
      workspaceRole: role,
    })
    if (!page.ok) notFound()
    return <WorkItemDetailView page={page} errorMessage={errorMessage} />
  })
}

function WorkItemDetailView({ page, errorMessage }: { page: WorkItemPageDto; errorMessage?: string }) {
  const flight = workItemClientFlightProps(page)
  const latestDecision = page.latestDecision

  return (
    <AppShell project={{ id: page.project.id, name: page.project.name }}>
      <RefreshOnFocus />
      <MarkPresentedIfCanAct canAct={flight.canAct} approvalId={flight.approvalId} />
      <div className="flex flex-wrap items-center gap-2">
        <PluginMark plugin={page.plugin} size="md" className="h-8 w-8" />
        <Badge
          variant={
            page.status === 'pending'
              ? 'warning'
              : page.status === 'failed_resume'
                ? 'warning'
                : page.status === 'decided'
                  ? 'success'
                  : 'secondary'
          }
        >
          {formatStatusLabel(page.status, latestDecision?.decision)}
        </Badge>
      </div>
      <div className="mt-4 flex max-w-2xl items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold">{page.actionName}</h1>
        {page.canCancel ? <ForceCancelButton approvalId={page.id} /> : null}
      </div>
      {errorMessage ? (
        <div className="mt-4 max-w-2xl rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
          <p className="text-sm font-semibold text-red-900 dark:text-red-200">Decision failed</p>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">{errorMessage}</p>
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">The work item is still pending. Please try again or contact support.</p>
        </div>
      ) : null}
      {page.originFields.length > 0 ? (
        <section className="mt-6 max-w-2xl rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">Origin</h2>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            {page.originFields.map((row) => (
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
          Project · {page.project.name}
        </summary>
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <p>
              <span className="text-zinc-500">Name</span>
              <br />
              <Link href={`/projects/${page.project.id}`} className="underline">
                {page.project.name}
              </Link>
            </p>
            <div>
              <span className="text-zinc-500">Plugin</span>
              <br />
              <PluginBadge plugin={page.project.plugin as PluginId} />
            </div>
            <p className="sm:col-span-2">
              <span className="text-zinc-500">Description</span>
              <br />
              {page.project.description || 'No description.'}
            </p>
            <p>
              <span className="text-zinc-500">Default SLA</span>
              <br />
              {page.project.defaultSlaMinutes} minutes
            </p>
            <p>
              <span className="text-zinc-500">Assigned to</span>
              <br />
              {page.assigned ? personLabel(page.assigned) : 'Unassigned'}
            </p>
            <p>
              <span className="text-zinc-500">Default assignee</span>
              <br />
              {page.defaultAssignee ? personLabel(page.defaultAssignee) : 'None'}
            </p>
            <p className="sm:col-span-2">
              <span className="text-zinc-500">People</span>
              <br />
              {page.people.length === 0
                ? 'No project members.'
                : page.people.map((person: WorkItemPerson) => `${personLabel(person)} · ${person.role}`).join(', ')}
            </p>
          </div>
          {page.canDelegate ? (
            <form action={delegateWorkItem.bind(null, page.id)} className="mt-4 flex max-w-xl gap-2">
              <input type="hidden" name="returnTo" value={page.returnTo} />
              <select
                name="userId"
                required
                className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Delegate to…</option>
                {page.delegateTargets.map((person) => (
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
        value={flight.contextMarkdown}
        externalUrls={flight.externalUrls}
        attachments={flight.attachments}
      />
      <h2 className="mt-4 max-w-2xl text-sm font-semibold">Action arguments</h2>
      <p className="mt-1 max-w-2xl text-xs text-zinc-500">Original request args from the stored create-once record.</p>
      <pre className="mt-2 max-w-2xl overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        {redactedRequestJson(page.originalArgs)}
      </pre>
      <JsonDisclosure value={page.jsonDisclosure} />
      <OriginalRequestPanel approvalId={page.id} />
      <EditedArgsPanel editedArgs={page.editedArgs} />
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
            {redactedRequestJson(page.originResponseJson)}
          </pre>
        </section>
      ) : null}
      {page.evidenceStoreUri ? (
        <section className="mt-8 max-w-2xl">
          <h2 className="text-sm font-semibold">Evidence</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            <a
              href={page.evidenceStoreUri}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              View evidence receipt
            </a>
          </p>
        </section>
      ) : null}
      {page.expired && page.status === 'pending' ? (
        <p className="mt-4 text-sm text-amber-700">This work item has expired.</p>
      ) : null}
      {page.canAct && !page.expired ? (
        <AnswerForm
          approvalId={flight.approvalId}
          allowed={flight.allowed}
          editableFields={flight.editableFields}
          originalArgs={flight.originalArgs}
          editReasonConfig={flight.editReasonConfig}
          respondAllowed={flight.respondAllowed}
          answerSchema={flight.answerSchema}
          reasonRequired={flight.reasonRequired}
          gateItems={flight.gateItems}
          returnTo={flight.returnTo}
          decide={decideWorkItem.bind(null, page.id)}
        />
      ) : null}
      {page.canRetry ? (
        <form action={retryWorkItem.bind(null, page.id)} className="mt-4">
          <button type="submit" className="text-sm underline">
            Retry resume
          </button>
        </form>
      ) : null}
    </AppShell>
  )
}
