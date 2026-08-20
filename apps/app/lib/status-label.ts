import type { ApprovalStatus, Decision } from '@hitly/core'

export function formatStatusLabel(status: ApprovalStatus | string, decision?: Decision | string | null): string {
  if (status === 'decided' && decision) {
    return `decided: ${decision}`
  }
  if (status === 'failed_resume') {
    return 'failed_resume'
  }
  return status
}
