import { Badge } from '@hitly/ui'

export function InboxPreview() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20">
      <h2 className="text-2xl font-semibold">The approval card</h2>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">What a reviewer sees when a Mastra step suspends.</p>
      <div className="mt-8 max-w-xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between">
          <Badge variant="secondary">Mastra</Badge>
          <span className="text-xs text-zinc-500">pending · 2m</span>
        </div>
        <h3 className="mt-4 text-lg font-semibold">send-refund</h3>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Refund $42.00 to order #1842. Human approval required before the charge is reversed.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-100">
          {`{ "orderId": "1842", "amount": 4200, "currency": "usd" }`}
        </pre>
        <div className="mt-4 flex gap-2">
          <span className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white">Accept</span>
          <span className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium">Edit</span>
          <span className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium">Reject</span>
        </div>
      </div>
    </section>
  )
}
