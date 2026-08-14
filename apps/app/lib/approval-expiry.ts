export function approvalHasExpired(approval: { status: string; expiresAt: Date | null }) {
  if (approval.status === 'expired') return true
  return approval.status === 'pending' && approval.expiresAt != null && approval.expiresAt.getTime() < Date.now()
}
