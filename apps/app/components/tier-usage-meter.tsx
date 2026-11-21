import type { TierUsage } from '@/lib/tier-limit-result'

/**
 * Limit/usage line shown where a capped action lives (seats next to the
 * invite form, live projects next to the create control, decisions on the
 * project config, retention next to the retry). When new use would be
 * refused it also renders the plan-appropriate upgrade path.
 * Presentational only — safe on server and client.
 */
export function TierUsageMeter({ title, usage }: { title: string; usage: TierUsage }) {
  const text =
    usage.limit === null
      ? usage.reached
        ? `${title}: not available on your plan`
        : `${title}: unlimited on your plan`
      : `${title}: ${Math.min(usage.usage, usage.limit)} of ${usage.limit} used`
  return (
    <p data-testid="tier-usage-meter" className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
      {text}
      {usage.reached && usage.upgrade ? (
        <>
          {' · '}
          <a href={usage.upgrade.href} data-testid="tier-usage-upgrade" className="underline">
            {usage.upgrade.label}
          </a>
        </>
      ) : null}
    </p>
  )
}
