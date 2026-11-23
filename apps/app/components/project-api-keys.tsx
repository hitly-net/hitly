'use client'

import { useState } from 'react'
import {
  createProjectApiKey,
  deleteProjectApiKey,
  regenerateProjectApiKey,
  type ApiKeyActionResult,
} from '@/actions/projects'
import { VerifyEmailRequiredNotice } from '@/components/verify-email-required'
import { TierLimitNotice } from '@/components/tier-limit-notice'
import { isGateBlockedResult } from '@/lib/verified-gate'
import { isTierLimitBlockedResult, type TierLimitBlockedResult, type UpgradeHint } from '@/lib/tier-limit-result'

export type ProjectApiKeyRow = {
  id: string
  name: string
  prefix: string
  lastUsedAt: string | null
}

export function ProjectApiKeys({
  projectId,
  keys,
  readOnly,
  createKey = createProjectApiKey,
  regenerate = regenerateProjectApiKey,
  upgrade = null,
}: {
  projectId: string
  keys: ProjectApiKeyRow[]
  readOnly?: boolean
  createKey?: (projectId: string, formData: FormData) => Promise<ApiKeyActionResult>
  regenerate?: (projectId: string, keyId: string) => Promise<ApiKeyActionResult>
  upgrade?: UpgradeHint | null
}) {
  const [raw, setRaw] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // A gate-blocked create/regenerate renders the typed state; the action
  // never throws for the gate, so there is no error page and no error id.
  const [gateBlocked, setGateBlocked] = useState(false)
  // An api_keys cap refusal returns its own typed state and renders the
  // refusal message with the plan-appropriate upgrade path.
  const [tierBlocked, setTierBlocked] = useState<TierLimitBlockedResult | null>(null)

  function applyResult(result: ApiKeyActionResult) {
    if (isGateBlockedResult(result)) {
      setGateBlocked(true)
      setTierBlocked(null)
      setRaw(null)
    } else if (isTierLimitBlockedResult(result)) {
      setGateBlocked(false)
      setTierBlocked(result)
      setRaw(null)
    } else {
      setGateBlocked(false)
      setTierBlocked(null)
      setRaw(result.apiKey)
    }
  }

  async function onCreate(formData: FormData) {
    setBusyId('create')
    try {
      applyResult(await createKey(projectId, formData))
    } finally {
      setBusyId(null)
    }
  }

  async function onRegenerate(keyId: string) {
    if (!window.confirm('Regenerate this key? The current secret will stop working immediately.')) return
    setBusyId(keyId)
    try {
      applyResult(await regenerate(projectId, keyId))
    } finally {
      setBusyId(null)
    }
  }

  async function onDelete(keyId: string) {
    if (!window.confirm('Delete this API key? Origins using it will fail ingest.')) return
    setBusyId(keyId)
    try {
      await deleteProjectApiKey(projectId, keyId)
      setRaw(null)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <ul className="mt-3 max-w-xl divide-y divide-zinc-200 dark:divide-zinc-800">
        {keys.length === 0 ? (
          <li className="py-2 text-sm text-zinc-500">No API keys yet.</li>
        ) : (
          keys.map((key) => (
            <li key={key.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 font-mono text-xs">
                {key.name} · {key.prefix}… · {key.lastUsedAt ? `last used ${key.lastUsedAt}` : 'never used'}
              </span>
              <button
                type="button"
                disabled={readOnly || busyId !== null}
                onClick={() => void onRegenerate(key.id)}
                className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
              >
                {busyId === key.id ? 'Working…' : 'Regenerate'}
              </button>
              <button
                type="button"
                disabled={readOnly || busyId !== null}
                onClick={() => void onDelete(key.id)}
                className="shrink-0 text-xs text-zinc-500 hover:text-red-600 disabled:opacity-50"
              >
                Delete
              </button>
            </li>
          ))
        )}
      </ul>
      {readOnly ? null : (
      <form className="mt-4 flex max-w-xl flex-col gap-3" action={onCreate}>
        <div className="flex gap-2">
          <input
            name="name"
            placeholder="Key name"
            defaultValue="Ingest key"
            className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={busyId !== null}
            className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Create key
          </button>
        </div>
        {gateBlocked ? <VerifyEmailRequiredNotice /> : null}
        {tierBlocked ? <TierLimitNotice result={tierBlocked} upgrade={upgrade} /> : null}
        {raw ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 font-mono text-xs break-all dark:border-amber-900 dark:bg-amber-950">
            Copy now — this is shown once: {raw}
          </p>
        ) : null}
      </form>
      )}
    </>
  )
}
