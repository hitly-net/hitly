'use client'

import { useState } from 'react'
import { redactedRequestJsonFromCanonical } from '@/lib/redact-request-payload'

/**
 * "View original request" panel (hitly#98): opens the create-once
 * `hitl/request/v0` payload lazily (only on explicit open, so the stored record is
 * not shipped on every detail-page render). Read-only: Copy and Download (JSON) of
 * the redacted payload; `payloadHash` / `argsHash` of the stored original for
 * off-host verification. The UI redacts again as a second line of defence.
 * `editedArgs` is never rendered here — see EditedArgsPanel.
 */

type OriginalRequestResponse = {
  ok: true
  requestId: string
  canonicalPayload: string
  payloadSha256: string
  argsSha256: string
  payloadHash: string
  argsHash: string
  evidence?: { eventId: string; contentSha256: string; seq: number }
}

function downloadJson(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  // preventDefault so jsdom does not treat the blob URL as navigation.
  anchor.addEventListener('click', (event) => event.preventDefault())
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function OriginalRequestPanel({ approvalId }: { approvalId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<OriginalRequestResponse | null>(null)
  const [copied, setCopied] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/v1/approvals/${encodeURIComponent(approvalId)}/original-request`, {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `Request failed (HTTP ${response.status})`)
        return
      }
      setData((await response.json()) as OriginalRequestResponse)
    } catch {
      setError('Could not load the original request. Try again.')
    } finally {
      setLoading(false)
    }
  }

  function onToggle() {
    const next = !open
    setOpen(next)
    if (next && !data && !loading) void load()
  }

  const displayJson = data ? redactedRequestJsonFromCanonical(data.canonicalPayload) : ''

  async function copy() {
    if (!data) return
    await navigator.clipboard.writeText(displayJson)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  function download() {
    if (!data) return
    downloadJson(`original-request-${data.requestId}.json`, displayJson)
  }

  return (
    <section className="mt-4 max-w-2xl rounded-md border border-zinc-200 dark:border-zinc-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full cursor-pointer select-none px-3 py-2 text-left text-sm font-medium"
      >
        View original request
      </button>
      {open ? (
        <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Stored create-once request (read-only). JSON is redacted for display, copy and
            download; <span className="font-mono">payloadHash</span> and{' '}
            <span className="font-mono">argsHash</span> are of the stored original so you can
            verify off-host.
          </p>
          {loading ? <p className="mt-2 text-sm text-zinc-500">Loading…</p> : null}
          {error ? <p className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
          {data ? (
            <>
              <pre
                data-testid="original-request-json"
                className="mt-2 max-h-96 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900"
              >
                {displayJson}
              </pre>
              <div className="mt-2 flex items-start justify-between gap-3">
                <dl className="space-y-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  <div>payloadHash {data.payloadHash}</div>
                  <div>argsHash {data.argsHash}</div>
                  {data.evidence ? (
                    <div>
                      evidence #{data.evidence.seq} {data.evidence.contentSha256}
                    </div>
                  ) : null}
                </dl>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => void copy()}
                    className="rounded-md border border-zinc-200 px-3 py-1 text-sm dark:border-zinc-700"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={download}
                    className="rounded-md border border-zinc-200 px-3 py-1 text-sm dark:border-zinc-700"
                  >
                    Download (JSON)
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
