'use client'

import { useState, type FormEvent } from 'react'
import { inviteToWorkspace, resendInvite } from '@/actions/team'
import { VerifyEmailRequiredNotice } from '@/components/verify-email-required'
import { TierLimitNotice } from '@/components/tier-limit-notice'
import { isGateBlockedResult, type GateBlockedResult } from '@/lib/verified-gate'
import { isTierLimitBlockedResult, type TierLimitBlockedResult, type UpgradeHint } from '@/lib/tier-limit-result'

/**
 * Invite form for the team page. A gate-blocked invite send returns the typed
 * state (never a throw/500), so the form renders the shared
 * "Verify your email to continue" notice with the rate-limited resend link.
 * A tier-cap refusal (seat limit) returns its own typed state and renders the
 * refusal message with the plan-appropriate upgrade path.
 */
export function WorkspaceInviteForm({
  invite = inviteToWorkspace,
  upgrade = null,
}: {
  invite?: (formData: FormData) => Promise<GateBlockedResult | TierLimitBlockedResult | void>
  upgrade?: UpgradeHint | null
}) {
  const [gateBlocked, setGateBlocked] = useState(false)
  const [tierBlocked, setTierBlocked] = useState<TierLimitBlockedResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await invite(new FormData(event.currentTarget))
      setGateBlocked(isGateBlockedResult(result))
      setTierBlocked(isTierLimitBlockedResult(result) ? result : null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 max-w-md">
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          name="email"
          type="email"
          required
          placeholder="Invite email"
          className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <select
          name="role"
          defaultValue="member"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Invite
        </button>
      </form>
      {gateBlocked ? (
        <div className="mt-2">
          <VerifyEmailRequiredNotice />
        </div>
      ) : null}
      {tierBlocked ? <TierLimitNotice result={tierBlocked} upgrade={upgrade} /> : null}
    </div>
  )
}

/**
 * Resend button for one pending invite. Same gate and same typed blocked
 * state as the invite form: a refused resend renders the notice, the invite
 * row keeps its current link, and nothing is sent.
 */
export function ResendInviteButton({
  inviteId,
  resend = resendInvite,
}: {
  inviteId: string
  resend?: (inviteId: string) => Promise<GateBlockedResult | void>
}) {
  const [gateBlocked, setGateBlocked] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onClick() {
    setBusy(true)
    try {
      const result = await resend(inviteId)
      setGateBlocked(isGateBlockedResult(result))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void onClick()}
        className="text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
      >
        Resend
      </button>
      {gateBlocked ? <VerifyEmailRequiredNotice /> : null}
    </div>
  )
}
