import type { TierLimitBlockedResult, UpgradeHint } from '@/lib/tier-limit-result'

/**
 * Shared notice for a tier-cap refusal in a server action's typed result:
 * the human message plus the plan-appropriate upgrade path (Free/Pro link
 * to /signup billing, Team/Enterprise the contact path, self-hosted none).
 * Presentational only — safe on server and client.
 */
export function TierLimitNotice({
  result,
  upgrade,
}: {
  result: TierLimitBlockedResult
  upgrade: UpgradeHint | null
}) {
  return (
    <div
      data-testid="tier-limit-notice"
      className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <p>{result.message}</p>
      {upgrade ? (
        <a href={upgrade.href} data-testid="tier-limit-upgrade" className="mt-1 inline-block font-medium underline">
          {upgrade.label}
        </a>
      ) : null}
    </div>
  )
}
