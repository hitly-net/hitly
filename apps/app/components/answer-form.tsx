'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import type { AllowedActions, Decision, EditReasonConfig, EditableFieldSpec } from '@hitly/core'
import { EditableFieldsForm } from './editable-fields-form'

/** One `mustOpen` context item (hitl-spec 3.7) as the answer form needs it. */
export interface GateItem {
  /** Gating key (declared ref, or derived from the url). */
  ref: string
  label: string
  url?: string
  /** Opened by THIS reviewer yet? Gating is per-reviewer (spec 3.7). */
  opened: boolean
}

/**
 * Draft reasons kept in client memory, keyed by approval, for one mount cycle.
 * A host refusal (400) bounces through a redirect that remounts the form; the
 * reviewer's typed reason survives here instead of being lost (hitly#96 S5).
 */
const reasonDrafts = new Map<string, string>()

function takeReasonDraft(approvalId: string): string {
  const draft = reasonDrafts.get(approvalId) ?? ''
  reasonDrafts.delete(approvalId)
  return draft
}

/**
 * Answer form for one work item: the reason prompt (spec 3.6), the must-open
 * checklist (spec 3.7) and the decision buttons. Ported UX patterns from the
 * approval-card design: reason required for the chosen answer, and acting answer
 * controls locked while mustOpen items are unopened (Ignore/dismiss is exempt).
 *
 * The client refuses invalid submits before they leave the form (reason missing,
 * mustOpen skipped on acting answers). That is presentation only — the host
 * re-validates every submission (see `validateAnswerSubmission` in @hitly/core).
 */
export function AnswerForm({
  approvalId,
  allowed,
  editableFields,
  originalArgs,
  editReasonConfig,
  respondAllowed,
  reasonRequired,
  gateItems,
  returnTo,
  decide,
}: {
  approvalId: string
  allowed: AllowedActions
  editableFields?: Record<string, EditableFieldSpec>
  originalArgs: Record<string, unknown>
  editReasonConfig?: EditReasonConfig
  respondAllowed: boolean
  reasonRequired: string[]
  gateItems: GateItem[]
  returnTo: string
  decide: (formData: FormData) => Promise<void>
}) {
  const router = useRouter()
  const [opened, setOpened] = useState<Set<string>>(
    () => new Set(gateItems.filter((item) => item.opened).map((item) => item.ref)),
  )
  // Controlled so a remount after a failed submit can restore the reviewer's
  // typed reason (S5): seeded from the draft stashed at the last submit attempt.
  const [reason, setReason] = useState<string>(() => takeReasonDraft(approvalId))
  const [notice, setNotice] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const lastClickedDecision = useRef<Decision | null>(null)

  const unopened = gateItems.filter((item) => !opened.has(item.ref))
  const blockedByMustOpen = unopened.length > 0

  async function recordOpen(item: GateItem) {
    try {
      const response = await fetch(`/api/v1/approvals/${approvalId}/opens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: item.ref }),
      })
      if (response.ok && !opened.has(item.ref)) {
        setOpened((current) => new Set(current).add(item.ref))
        router.refresh()
        return
      }
      if (!response.ok) {
        setNotice(`Could not record the open of "${item.label}" (HTTP ${response.status}). Open it again to retry.`)
      }
    } catch {
      // This endpoint is the only place the host records the open; a failed report
      // leaves the item gated, so ask the reviewer to retry rather than swallow it.
      setNotice(`Could not record the open of "${item.label}". Open it again to retry.`)
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null
    const decision = submitter?.getAttribute('value') ?? lastClickedDecision.current
    lastClickedDecision.current = null
    if (!decision) return
    // mustOpen gates acting answers only; Ignore/dismiss is exempt (spec 3.7).
    if (blockedByMustOpen && decision !== 'ignore') {
      event.preventDefault()
      setNotice('Open the required context items before you answer.')
      return
    }
    if (reasonRequired.includes(decision)) {
      if (!reason.trim()) {
        event.preventDefault()
        setNotice(`A reason is required for "${decision}". Add one before submitting.`)
        reasonRef.current?.focus()
        return
      }
    }
    // The submit is going to the host: keep the typed reason so a refusal that
    // bounces back through a redirect remount still shows what was typed (S5).
    reasonDrafts.set(approvalId, reason)
  }

  return (
    <form ref={formRef} action={decide} onSubmit={handleSubmit} className="mt-6 flex max-w-xl flex-col gap-3">
      <input type="hidden" name="returnTo" value={returnTo} />
      {editableFields ? (
        <EditableFieldsForm fields={editableFields} originalArgs={originalArgs} editReasonConfig={editReasonConfig} />
      ) : null}
      {gateItems.length > 0 ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-700" data-testid="must-open-checklist">
          <p className="font-semibold">Open before answering</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {gateItems.map((item) => (
              <li key={item.ref} data-item-ref={item.ref}>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all underline"
                    onClick={() => void recordOpen(item)}
                    onAuxClick={(event) => {
                      // Middle-click opens in a new tab without firing onClick; record that too.
                      if (event.button === 1) void recordOpen(item)
                    }}
                  >
                    {item.label}
                  </a>
                ) : (
                  item.label
                )}
                <span className="text-zinc-500"> · {opened.has(item.ref) ? 'opened' : 'open before answering'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-500">
            Your opens are recorded (item and time) for the audit trail. Acting answer buttons unlock once every
            must-open item has been opened; Ignore stays available.
          </p>
        </div>
      ) : null}
      {reasonRequired.length > 0 ? (
        <textarea
          name="reason"
          ref={reasonRef}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={`Reason (required for: ${reasonRequired.join(', ')})`}
          className="rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      ) : null}
      {respondAllowed ? (
        <input
          name="response"
          placeholder="Response"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      ) : null}
      {notice ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {notice}
        </p>
      ) : null}
      <DecisionButtons
        allowed={allowed}
        locked={blockedByMustOpen}
        onDecisionClick={(decision) => {
          lastClickedDecision.current = decision
        }}
      />
    </form>
  )
}

function DecisionButtons({
  allowed,
  locked,
  onDecisionClick,
}: {
  allowed: AllowedActions
  locked: boolean
  onDecisionClick: (decision: Decision) => void
}) {
  const { pending } = useFormStatus()
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.entries(allowed) as [Decision, boolean][])
        .filter(([, on]) => on)
        .map(([decision]) => (
          <button
            key={decision}
            name="decision"
            value={decision}
            disabled={pending || (locked && decision !== 'ignore')}
            onClick={() => onDecisionClick(decision)}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium capitalize text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {decision}
          </button>
        ))}
    </div>
  )
}
