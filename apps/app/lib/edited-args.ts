/** Reviewer amendments from decide. Never the original create-once request. */

export function editedArgsFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const edited = (payload as Record<string, unknown>).editedArgs
  if (!edited || typeof edited !== 'object' || Array.isArray(edited)) return null
  return edited as Record<string, unknown>
}

export function omitEditedArgs(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { editedArgs: _edited, ...rest } = value as Record<string, unknown>
  void _edited
  return rest
}
