import type { WorkItemRow } from '../../types'

const DECISION_LABEL: Record<string, string> = {
  accept: 'accepted',
  reject: 'rejected',
  edit: 'edited',
  respond: 'responded',
  ignore: 'ignored',
  cancel: 'cancelled',
}

export function resultLabel(item: WorkItemRow) {
  if (item.status === 'decided' && item.decision) {
    return DECISION_LABEL[item.decision] ?? item.decision
  }
  return item.status.replaceAll('_', ' ')
}
