export function canShowEdit(
  allowedEdit: boolean,
  editableFields?: Record<string, unknown> | null,
): boolean {
  return Boolean(allowedEdit && editableFields && Object.keys(editableFields).length > 0)
}

/** Only allowlisted keys. Extra keys never posted. */
export function pickAllowlistedArgs(
  values: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    if (Object.prototype.hasOwnProperty.call(values, key)) out[key] = values[key]
  }
  return out
}

/** editedArgs / editReason / editReasonText are siblings. Never merge reason into args. */
export function buildEditSubmit(args: {
  values: Record<string, unknown>
  fields: Record<string, unknown>
  editReason?: string
  editReasonText?: string
}): { editedArgs: Record<string, unknown>; editReason?: string; editReasonText?: string } {
  const payload: { editedArgs: Record<string, unknown>; editReason?: string; editReasonText?: string } = {
    editedArgs: pickAllowlistedArgs(args.values, args.fields),
  }
  if (args.editReason) payload.editReason = args.editReason
  if (args.editReasonText) payload.editReasonText = args.editReasonText
  return payload
}
