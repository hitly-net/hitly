export function approvalHasExpired(approval: { status: string; expiresAt: Date | null }, now: number = Date.now()) {
  if (approval.status === 'expired') return true
  return approval.status === 'pending' && approval.expiresAt != null && approval.expiresAt.getTime() < now
}

/** The status a read must report: past-deadline pending rows read as expired. */
export function effectiveApprovalStatus(approval: { status: string; expiresAt: Date | null }, now: number = Date.now()) {
  return approval.status === 'pending' && approval.expiresAt != null && approval.expiresAt.getTime() < now
    ? 'expired'
    : approval.status
}
