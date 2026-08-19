import type { ApprovalDetail } from '../../types'

export type DecideOutcome =
  | { action: 'back' }
  | { action: 'stay'; detail: ApprovalDetail }

export async function handleDecideError(
  reloadDetail: () => Promise<ApprovalDetail | null>,
): Promise<DecideOutcome> {
  const next = await reloadDetail()
  if (next) {
    return { action: 'stay', detail: next }
  }
  return { action: 'back' }
}
