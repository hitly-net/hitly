'use client'

import { useState } from 'react'

/**
 * "Export my data" button (GDPR). One POST to /api/session/export; the
 * response body is turned into a blob download named after the server's
 * Content-Disposition. Outcomes:
 * - 2xx: the zip download starts; a short success line is shown.
 * - 401: the session is gone; the message says to sign in again.
 * - 429: once-per-hour limit hit; the Retry-After is shown in minutes.
 * - anything else (including 413 too-large and network failure): a fixed
 *   retry message. Never shows server detail.
 */

export const EXPORT_ENDPOINT = '/api/session/export'

export const EXPORT_LIMITED_MESSAGE = 'You have already exported your data recently. Try again in an hour.'
export const EXPORT_FAILURE_MESSAGE = 'The export failed. Try again; if it keeps failing, contact support.'
export const EXPORT_SUCCESS_MESSAGE = 'Your data export has been downloaded.'

export function retryAfterMinutes(retryAfter: string | null): string | null {
  const seconds = Number(retryAfter)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return String(Math.max(1, Math.ceil(seconds / 60)))
}

function filenameFromDisposition(disposition: string | null): string {
  const match = disposition?.match(/filename="?([^";]+)"?/)
  return match?.[1] ?? 'hitly-data-export.zip'
}

export function DataExportButton({ className }: { className?: string }) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null)

  async function onClick() {
    if (pending) return
    setPending(true)
    setMessage(null)
    try {
      const response = await fetch(EXPORT_ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (response.ok) {
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filenameFromDisposition(response.headers.get('content-disposition'))
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
        setMessage({ tone: 'ok', text: EXPORT_SUCCESS_MESSAGE })
        return
      }
      if (response.status === 401) {
        setMessage({ tone: 'warn', text: 'Your session expired. Sign in again and retry.' })
      } else if (response.status === 429) {
        const minutes = retryAfterMinutes(response.headers.get('retry-after'))
        setMessage({
          tone: 'warn',
          text: minutes ? `${EXPORT_LIMITED_MESSAGE} (about ${minutes} minute${minutes === '1' ? '' : 's'} left)` : EXPORT_LIMITED_MESSAGE,
        })
      } else {
        setMessage({ tone: 'error', text: EXPORT_FAILURE_MESSAGE })
      }
    } catch {
      setMessage({ tone: 'error', text: EXPORT_FAILURE_MESSAGE })
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        className={className ?? 'rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800'}
        onClick={() => {
          void onClick()
        }}
      >
        {pending ? 'Preparing export…' : 'Export my data'}
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
