/**
 * Message recorded on an approval when resuming the origin throws.
 * Destination check errors already carry a fixed, generic message (status and
 * host only), so they are kept as they are.
 */
export function resumeFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'DestinationCheckError') return `Resume failed: ${error.message}`
  if (error instanceof Error && error.message) return error.message
  return 'Resume failed'
}
