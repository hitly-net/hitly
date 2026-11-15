/**
 * Support ticket types for HITLy support -> Zammad. This is the ONE home of
 * the list (the package is self-contained; this file does not depend on any
 * other @hitly workspace package). The Zammad Object Manager select
 * attribute `hitly_type` is derived from this list by
 * scripts/setup-hitly-type-field.ts.
 * Adding a type is ONE line here (value = stable API id, label = display).
 */
export const SUPPORT_TICKET_TYPES = [
  { value: 'billing', label: 'Billing' },
  { value: 'account', label: 'Account' },
  { value: 'data', label: 'Data' },
  { value: 'general', label: 'General' },
  { value: 'feature', label: 'Feature request' },
  { value: 'bug', label: 'Bug' },
  { value: 'security', label: 'Security/Abuse' },
] as const

export type SupportTicketType = (typeof SUPPORT_TICKET_TYPES)[number]['value']

export function isSupportTicketType(value: string): value is SupportTicketType {
  return SUPPORT_TICKET_TYPES.some((type) => type.value === value)
}

/** `{ billing: 'Billing', ... }` — Zammad select attribute options map. */
export function supportTicketTypeOptions(): Record<string, string> {
  return Object.fromEntries(SUPPORT_TICKET_TYPES.map((t) => [t.value, t.label]))
}
