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
 * Answer form for one work item: the reason prompt (spec 3.6), the must-open
 * checklist (spec 3.7) and the decision buttons. Ported UX patterns from
 * Tourbillon WID-2 (approval-card): reason required for the chosen answer, and
 * answer controls locked while mustOpen items are unopened.
 *
 * The client refuses invalid submits before they leave the form (reason missing,
 * mustOpen skipped). That is presentation only — the host re-validates every
 * submission (see `validateAnswerSubmission` in @hitly/core).
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
      }
    } catch {
      // Opening still happened locally; the host records the audit trail on submit.
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null
    const decision = submitter?.getAttribute('value') ?? lastClickedDecision.current
    lastClickedDecision.current = null
    if (!decision) return
    if (blockedByMustOpen) {
      event.preventDefault()
      setNotice('Open the required context items before you answer.')
      return
    }
    if (reasonRequired.includes(decision)) {
      const reason = formRef.current ? String(new FormData(formRef.current).get('reason') ?? '').trim() : ''
      if (!reason) {
        event.preventDefault()
        setNotice(`A reason is required for "${decision}". Add one before submitting.`)
        reasonRef.current?.focus()
      }
    }
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
            Your opens are recorded (item and time) for the audit trail. The answer buttons unlock once every
            must-open item has been opened.
          </p>
        </div>
      ) : null}
      {reasonRequired.length > 0 ? (
        <textarea
          name="reason"
          ref={reasonRef}
          rows={3}
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
            disabled={pending || locked}
            onClick={() => onDecisionClick(decision)}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium capitalize text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {decision}
          </button>
        ))}
    </div>
  )
}
