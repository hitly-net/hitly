'use client'

import { useState } from 'react'

/**
 * "Request my data" button (UK GDPR right of access). One POST to
 * /api/session/data-request records the ask with support; a support engineer
 * prepares the export and sends it manually — this button never downloads
 * anything. The response carries the UK GDPR one-month response deadline and
 * the confirmation names it. Outcomes:
 * - 2xx (new or already open): the confirmation line, with the deadline date.
 * - 401: the session is gone; the message says to sign in again.
 * - 429: rate limited; the Retry-After is shown in minutes.
 * - anything else (including network failure): a fixed retry message.
 *   Never shows server detail.
 */

export const DATA_REQUEST_ENDPOINT = '/api/session/data-request'

export const DATA_REQUEST_LIMITED_MESSAGE = 'You have asked for this recently. Try again in an hour.'
export const DATA_REQUEST_FAILURE_MESSAGE =
  'Your data request could not be recorded. Try again; if it keeps failing, contact support.'

/** The confirmation sentence, with the UK GDPR one-month deadline spelled out. */
export function dataRequestConfirmation(responseByIso: string | undefined): string {
  const base =
    'Your data request has been recorded and sent to support. Under UK GDPR you will receive a copy of your personal data within one month'
  if (!responseByIso) return `${base}.`
  const date = new Date(responseByIso)
  if (Number.isNaN(date.getTime())) return `${base}.`
  const formatted = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  return `${base}, by ${formatted}.`
}

export function retryAfterMinutes(retryAfter: string | null): string | null {
  const seconds = Number(retryAfter)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return String(Math.max(1, Math.ceil(seconds / 60)))
}

export function DataRequestButton({ className }: { className?: string }) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null)

  async function onClick() {
    if (pending) return
    setPending(true)
    setMessage(null)
    try {
      const response = await fetch(DATA_REQUEST_ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (response.ok) {
        let responseBy: string | undefined
        try {
          const body = (await response.json()) as { responseBy?: unknown }
          if (typeof body?.responseBy === 'string') responseBy = body.responseBy
        } catch {
          // Missing body detail still confirms the ask; only the date is lost.
        }
        setMessage({ tone: 'ok', text: dataRequestConfirmation(responseBy) })
        return
      }
      if (response.status === 401) {
        setMessage({ tone: 'warn', text: 'Your session expired. Sign in again and retry.' })
      } else if (response.status === 429) {
        const minutes = retryAfterMinutes(response.headers.get('retry-after'))
        setMessage({
          tone: 'warn',
          text: minutes
            ? `${DATA_REQUEST_LIMITED_MESSAGE} (about ${minutes} minute${minutes === '1' ? '' : 's'} left)`
            : DATA_REQUEST_LIMITED_MESSAGE,
        })
      } else {
        setMessage({ tone: 'error', text: DATA_REQUEST_FAILURE_MESSAGE })
      }
    } catch {
      setMessage({ tone: 'error', text: DATA_REQUEST_FAILURE_MESSAGE })
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        className={
          className ??
          'rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
        }
        onClick={() => {
          void onClick()
        }}
      >
        {pending ? 'Sending request…' : 'Request my data'}
      </button>
      {message ? (
        <p
          role={message.tone === 'ok' ? 'status' : 'alert'}
          className={`mt-2 text-xs ${
            message.tone === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : message.tone === 'warn'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-red-600 dark:text-red-400'
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  )
}
