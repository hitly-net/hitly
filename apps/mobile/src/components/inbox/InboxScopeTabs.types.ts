export const INBOX_SCOPES = ['open', 'all', 'closed'] as const
export type InboxScope = (typeof INBOX_SCOPES)[number]

export function isInboxScope(value: string | undefined): value is InboxScope {
  return Boolean(value && (INBOX_SCOPES as readonly string[]).includes(value))
}
