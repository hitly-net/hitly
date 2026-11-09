/**
 * Defence-in-depth UI gate for mobile `presented` (hitl-spec 5.2).
 * The server still no-ops readers; this keeps the client from POSTing at all
 * when `detail.canAct` is false (S97-S3).
 */
export function shouldRecordPresented(
  detail: { id: string; canAct: boolean } | null | undefined,
  alreadyRecordedForId: string | null,
): boolean {
  if (!detail || !detail.canAct) return false
  return alreadyRecordedForId !== detail.id
}
