'use client'

import { useState, type FormEvent } from 'react'
import {
  MFA_DISABLED_MESSAGE,
  MFA_ENROL_SUCCEEDED_MESSAGE,
  MFA_FACTOR_FIELD_PLACEHOLDER,
  MFA_RECOVERY_REGENERATED_MESSAGE,
  submitMfaConfirm,
  submitMfaDisable,
  submitMfaEnrol,
  submitMfaRecoveryCodes,
  type MfaEnrolResult,
  type MfaStatus,
} from '@/lib/mfa'

const INPUT_CLASS =
  'h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'

function RecoveryList({ codes }: { codes: string[] }) {
  return (
    <ol className="mt-2 grid grid-cols-2 gap-2 font-mono text-sm">
      {codes.map((code) => (
        <li key={code}>{code}</li>
      ))}
    </ol>
  )
}

export function MfaSetup({ status }: { status: MfaStatus }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [enrol, setEnrol] = useState<MfaEnrolResult | null>(null)
  const [enabled, setEnabled] = useState(status.enabled)
  const [remaining, setRemaining] = useState(status.recoveryCodesRemaining)
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function onEnrol(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const currentPassword = String(new FormData(form).get('currentPassword') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitMfaEnrol(currentPassword)
    setPending(false)
    if (!outcome.ok) {
      form.reset()
      setError(outcome.message)
      return
    }
    form.reset()
    setEnrol(outcome.enrol)
    setFreshCodes(null)
    setMessage(null)
  }

  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const code = String(new FormData(form).get('code') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitMfaConfirm(code)
    setPending(false)
    if (!outcome.ok) {
      setError(outcome.message)
      return
    }
    setEnabled(true)
    setRemaining(enrol?.recoveryCodes.length ?? remaining)
    setEnrol(null)
    setMessage(MFA_ENROL_SUCCEEDED_MESSAGE)
  }

  async function onDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const currentPassword = String(data.get('currentPassword') ?? '')
    const code = String(data.get('code') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitMfaDisable(currentPassword, code)
    setPending(false)
    if (!outcome.ok) {
      form.reset()
      setError(outcome.message)
      return
    }
    setEnabled(false)
    setRemaining(0)
    setFreshCodes(null)
    setMessage(MFA_DISABLED_MESSAGE)
  }

  async function onRegenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const currentPassword = String(data.get('currentPassword') ?? '')
    const code = String(data.get('code') ?? '')
    setPending(true)
    setError(null)
    const outcome = await submitMfaRecoveryCodes(currentPassword, code)
    setPending(false)
    if (!outcome.ok) {
      form.reset()
      setError(outcome.message)
      return
    }
    form.reset()
    setFreshCodes(outcome.recoveryCodes)
    setRemaining(outcome.recoveryCodes.length)
    setMessage(MFA_RECOVERY_REGENERATED_MESSAGE)
  }

  if (enrol) {
    return (
      <div className="flex max-w-md flex-col gap-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Scan the QR code with your authenticator app, or enter the secret manually. Store the
          recovery codes now; they will not be shown again.
        </p>
        <div
          className="w-44 rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-700"
          dangerouslySetInnerHTML={{ __html: enrol.qrSvg }}
        />
        <label className="text-sm">
          Secret
          <input readOnly value={enrol.secret} className={`mt-1 w-full ${INPUT_CLASS} font-mono`} />
        </label>
        <p className="break-all font-mono text-xs text-zinc-500">{enrol.otpauthUri}</p>
        <RecoveryList codes={enrol.recoveryCodes} />
        <form onSubmit={onConfirm} className="flex flex-col gap-3">
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            pattern="\d{6}"
            placeholder="6-digit code"
            className={INPUT_CLASS}
          />
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Confirm and enable
          </button>
        </form>
      </div>
    )
  }

  if (enabled) {
    return (
      <div className="flex max-w-md flex-col gap-6">
        {message ? (
          <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
            {message}
          </p>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Authenticator app MFA is on. Unused recovery codes remaining: {remaining}.
          </p>
        )}
        {freshCodes ? <RecoveryList codes={freshCodes} /> : null}
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <form onSubmit={onRegenerate} className="flex flex-col gap-3">
          <input
            name="currentPassword"
            type="password"
            required
            placeholder="Current password"
            autoComplete="current-password"
            className={INPUT_CLASS}
          />
          <input
            name="code"
            required
            autoComplete="one-time-code"
            placeholder={MFA_FACTOR_FIELD_PLACEHOLDER}
            className={INPUT_CLASS}
          />
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-md border border-zinc-300 text-sm font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            Regenerate recovery codes
          </button>
        </form>
        <form onSubmit={onDisable} className="flex flex-col gap-3">
          <input
            name="currentPassword"
            type="password"
            required
            placeholder="Current password"
            autoComplete="current-password"
            className={INPUT_CLASS}
          />
          <input
            name="code"
            required
            autoComplete="one-time-code"
            placeholder={MFA_FACTOR_FIELD_PLACEHOLDER}
            className={INPUT_CLASS}
          />
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Disable MFA
          </button>
        </form>
      </div>
    )
  }

  return (
    <form onSubmit={onEnrol} className="flex max-w-md flex-col gap-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Add an authenticator app. You will confirm a code before MFA is turned on. SMS is not used.
      </p>
      {message ? (
        <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
          {message}
        </p>
      ) : null}
      <input
        name="currentPassword"
        type="password"
        required
        placeholder="Current password"
        autoComplete="current-password"
        className={INPUT_CLASS}
      />
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-md bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Enable authenticator app
      </button>
    </form>
  )
}
