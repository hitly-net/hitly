'use client'

import { useState, type FormEvent } from 'react'
import { startAuthentication } from '@simplewebauthn/browser'
import {
  DELETION_CONFIRMATION_WORD,
  confirmationMatches,
  submitAccountDeletion,
  submitAccountExport,
  submitDeletionAssertionOptions,
  submitDeletionPasskeyReauth,
  submitDeletionPasswordReauth,
  type DeletionPreview,
} from '@/lib/account-deletion'

const INPUT_CLASS =
  'h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'
const DANGER_BUTTON_CLASS =
  'h-10 rounded-md bg-red-700 text-sm font-medium text-white disabled:opacity-40'

/**
 * The delete-account danger zone.
 *
 * Step 1 shows exactly what is destroyed — the sole-member workspaces with
 * their project / API-key / decision counts — and offers the export BEFORE
 * anything goes. Step 2 asks for a fresh proof of identity (current password
 * or a user-verified passkey) and for the word DELETE typed by hand; the
 * button stays disabled until both are in place. The server re-checks every
 * one of these independently — this form is guidance, not the guard.
 */
export function DeleteAccountForm({ preview, hasPasskey }: { preview: DeletionPreview; hasPasskey: boolean }) {
  const [step, setStep] = useState<'summary' | 'confirm'>('summary')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [ticket, setTicket] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  if (deleted) {
    return (
      <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
        Your account has been deleted. This is permanent, and a confirmation email has been sent.
      </p>
    )
  }

  async function onExport() {
    setError(null)
    const outcome = await submitAccountExport()
    if (!outcome.ok) setError(outcome.message)
  }

  async function onPasswordReauth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const currentPassword = String(form.get('currentPassword') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitDeletionPasswordReauth(currentPassword)
    if (outcome.ok) setTicket(outcome.ticket)
    else setError(outcome.message)
    setPending(false)
  }

  async function onPasskeyReauth() {
    setPending(true)
    setError(null)
    const options = await submitDeletionAssertionOptions()
    if (!options.ok) {
      setError(options.message)
      setPending(false)
      return
    }
    try {
      const assertion = await startAuthentication(options.options as never)
      const outcome = await submitDeletionPasskeyReauth(assertion)
      if (outcome.ok) setTicket(outcome.ticket)
      else setError(outcome.message)
    } catch {
      setError('The passkey prompt was cancelled.')
    } finally {
      setPending(false)
    }
  }

  async function onDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ticket || !confirmationMatches(typed)) return
    setPending(true)
    setError(null)
    const outcome = await submitAccountDeletion(typed, ticket)
    if (outcome.ok) setDeleted(true)
    else {
      // Any refusal spends the ticket: a fresh proof is required to retry.
      setTicket(null)
      setError(outcome.message)
    }
    setPending(false)
  }

  if (step === 'summary') {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <section aria-labelledby="deletion-deleted-heading" className="flex flex-col gap-2">
          <h3 id="deletion-deleted-heading" className="text-sm font-semibold">
            Deleted with your account
          </h3>
          {preview.deletableWorkspaces.length === 0 ? (
            <p className="text-sm text-zinc-500">No workspace belongs to you alone.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {preview.deletableWorkspaces.map((workspace) => (
                <li key={workspace.id} data-testid={`deletable-${workspace.id}`}>
                  {workspace.name} — {workspace.projects} project(s), {workspace.apiKeys} API key(s),{' '}
                  {workspace.decisions} decision(s)
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-zinc-500">
            Projects, API keys, approvals and decisions inside these workspaces are erased. Export them first if you
            need a copy.
          </p>
        </section>

        {preview.keptWorkspaces.length > 0 ? (
          <section aria-labelledby="deletion-kept-heading" className="flex flex-col gap-2">
            <h3 id="deletion-kept-heading" className="text-sm font-semibold">
              Kept (you are a member of these with others)
            </h3>
            <ul className="flex flex-col gap-1 text-sm">
              {preview.keptWorkspaces.map((workspace) => (
                <li key={workspace.id}>
                  {workspace.name} — your membership is removed; its {workspace.apiKeys} API key(s) stay for the other
                  members, who are emailed to review them
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {preview.hasBlocker ? (
          <section aria-labelledby="deletion-blocked-heading" className="flex flex-col gap-2">
            <h3 id="deletion-blocked-heading" className="text-sm font-semibold text-red-700 dark:text-red-400">
              Resolve first
            </h3>
            <ul className="flex flex-col gap-1 text-sm">
              {preview.blockedWorkspaces.map((blocked) => (
                <li key={blocked.id} data-testid={`blocked-${blocked.id}`}>
                  {blocked.name}: {blocked.message}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onExport()}
            disabled={pending}
            className="h-10 rounded-md border border-zinc-300 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            Export my data
          </button>
          <button
            type="button"
            onClick={() => setStep('confirm')}
            disabled={preview.hasBlocker}
            className={DANGER_BUTTON_CLASS}
          >
            Continue to deletion
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-sm text-zinc-500">
        Confirm it is really you, then type <strong>{DELETION_CONFIRMATION_WORD}</strong> below.
      </p>

      <form onSubmit={onPasswordReauth} className="flex flex-col gap-2">
        <input
          name="currentPassword"
          type="password"
          required
          placeholder="Current password"
          autoComplete="current-password"
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={pending} className="h-10 w-56 rounded-md border border-zinc-300 text-sm font-medium disabled:opacity-50 dark:border-zinc-700">
          Confirm with password
        </button>
      </form>

      {hasPasskey ? (
        <button
          type="button"
          onClick={() => void onPasskeyReauth()}
          disabled={pending}
          className="h-10 w-56 rounded-md border border-zinc-300 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
        >
          Confirm with a passkey
        </button>
      ) : null}

      <p role="status" className="text-sm">
        {ticket ? 'Identity confirmed. Finish below.' : 'Not confirmed yet.'}
      </p>

      <form onSubmit={onDelete} className="flex flex-col gap-2">
        <input
          name="confirmation"
          type="text"
          required
          placeholder={`Type ${DELETION_CONFIRMATION_WORD}`}
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={pending || !ticket || !confirmationMatches(typed)} className={DANGER_BUTTON_CLASS}>
          Delete my account permanently
        </button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => setStep('summary')}
        className="h-10 w-40 self-start rounded-md border border-zinc-300 text-sm font-medium dark:border-zinc-700"
      >
        Back
      </button>
    </div>
  )
}
