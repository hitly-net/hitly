import type { InboxSummary } from '../../types'
import { AttentionCard } from './AttentionCard'

export function AttentionSummary({
  summary,
  onPending,
  onFailed,
}: {
  summary: InboxSummary
  onPending: () => void
  onFailed: () => void
}) {
  return (
    <>
      <AttentionCard label="Needs attention" count={summary.pending} onPress={onPending} />
      <AttentionCard label="Failed resume" count={summary.failedResume} onPress={onFailed} />
      <AttentionCard label="Decided today" count={summary.decidedToday} onPress={onPending} />
    </>
  )
}
