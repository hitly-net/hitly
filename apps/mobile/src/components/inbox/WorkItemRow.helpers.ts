import type { WorkItemRow } from '../../types'

export function resultLabel(item: WorkItemRow) {
  if (item.status === 'decided' && item.decision) {
    return `decided: ${item.decision}`
  }
  if (item.status === 'failed_resume') {
    return 'failed_resume'
  }
  return item.status
}
