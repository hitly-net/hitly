import { redactedRequestJson } from '@/lib/redact-request-payload'

/**
 * Reviewer amendments from decide. Never the original create-once request
 * (hitly#98): that lives in OriginalRequestPanel.
 */

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

export function EditedArgsPanel({ editedArgs }: { editedArgs: Record<string, unknown> | null }) {
  if (!editedArgs) return null
  return (
    <section
      className="mt-4 max-w-2xl rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
      data-testid="edited-args-panel"
    >
      <h2 className="text-sm font-semibold">Edited arguments</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Reviewer amendments from the decide step. This is not the original create-once request.
      </p>
      <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        {redactedRequestJson(editedArgs)}
      </pre>
    </section>
  )
}
