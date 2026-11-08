'use client'

import { useState } from 'react'

/**
 * "View original request" panel (hitly#98): opens the create-once
 * `hitl/request/v0` payload lazily (only on explicit open, so the stored bytes are
 * not shipped on every detail-page render) and offers a byte-exact Copy for
 * off-host verification. Same authentication as the approval detail: the route
 * answers 404 for anyone who cannot open the approval itself.
 *
 * The copy hands out `canonicalPayload` verbatim — no redaction, no re-serialization
 * on the client (JSON.parse/stringify round-trips and editor whitespace would both
 * break the byte check; the sha256 shown here is what a verifier recomputes over the
 * exact copy). See lib/original-request.ts for the flagged redaction-vs-exactness
 * decision.
 */

type OriginalRequestResponse = {
  ok: true
  requestId: string
  canonicalPayload: string
  payloadSha256: string
  argsSha256: string
  evidence?: { eventId: string; contentSha256: string; seq: number }
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

  async function copy() {
    if (!data) return
    // Byte-exact: hand out the stored canonical bytes as received, untouched.
    await navigator.clipboard.writeText(data.canonicalPayload)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
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
            The stored create-once payload, canonical JSON, byte-exact — not re-rendered from the screen. Paste it
            into a known-good host or verifier to check what you are approving.
          </p>
          {loading ? <p className="mt-2 text-sm text-zinc-500">Loading…</p> : null}
          {error ? <p className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
          {data ? (
            <>
              <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                {data.canonicalPayload}
              </pre>
              <div className="mt-2 flex items-start justify-between gap-3">
                <dl className="space-y-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  <div>sha256 {data.payloadSha256}</div>
                  <div>args {data.argsSha256}</div>
                  {data.evidence ? <div>evidence #{data.evidence.seq} {data.evidence.contentSha256}</div> : null}
                </dl>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="shrink-0 rounded-md border border-zinc-200 px-3 py-1 text-sm dark:border-zinc-700"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
