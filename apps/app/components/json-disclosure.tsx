export function JsonDisclosure({
  title = 'Full JSON',
  value,
  className = 'mt-4 max-w-2xl rounded-md border border-zinc-200 dark:border-zinc-800',
}: {
  title?: string
  value: unknown
  className?: string
}) {
  return (
    <details className={className}>
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">{title}</summary>
      <pre className="max-h-96 overflow-auto border-t border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}
