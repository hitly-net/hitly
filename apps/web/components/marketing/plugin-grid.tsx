import Link from 'next/link'
import { Badge, HitlyWordmark } from '@hitly/ui'

const plugins = [
  {
    id: 'mastra',
    name: 'Mastra',
    status: 'Available',
    href: '/integrations/mastra',
    body: 'createHitlyApprovalStep() wraps suspend() and resume(). First-class plugin.',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    status: 'Available',
    href: '/integrations/hermes',
    body: 'Python approval transport for CLI/gateway commands; kanban block/review cards for autonomous profiles.',
  },
  {
    id: 'http',
    name: 'HTTP',
    status: 'Available',
    href: '/integrations/http',
    body: (
      <>
        POST ingest with a resumeUrl. <HitlyWordmark /> POSTs {'{ decision, id, metadata }'}. n8n, Notion, Make, custom callbacks.
      </>
    ),
  },
  {
    id: 'n8n',
    name: 'n8n',
    status: 'HTTP today',
    href: '/integrations/n8n',
    body: (
      <>
        Create an HTTP project. HTTP Request to <HitlyWordmark />, then Wait on webhook. <HitlyWordmark /> POSTs to $execution.resumeUrl.
      </>
    ),
  },
  {
    id: 'langgraph',
    name: 'LangGraph',
    status: 'Available',
    href: '/integrations/langgraph',
    body: (
      <>
        notify_hitly_approval() then interrupt(). Signed HumanResponse resumes the original thread. First-class plugin.
      </>
    ),
  },
  {
    id: 'temporal',
    name: 'Temporal',
    status: 'Available',
    href: '/integrations/temporal',
    body: (
      <>
        Activity POSTs the approval; condition() waits; <HitlyWordmark /> signals <code className="text-xs">hitly.decision</code>.
      </>
    ),
  },
]

export function PluginGrid() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="text-2xl font-semibold">Plugins</h2>
      <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
        We start with a handful of origins. HTTP covers n8n, Notion, and custom callbacks. We will support any framework that has demand.
      </p>
      <div className="mt-10 grid gap-4 md:grid-cols-2">
        {plugins.map((plugin) => (
          <Link
            key={plugin.id}
            href={plugin.href}
            className="rounded-xl border border-zinc-200 p-6 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{plugin.name}</h3>
              <Badge variant={plugin.status === 'Coming soon' ? 'warning' : 'success'}>{plugin.status}</Badge>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{plugin.body}</p>
          </Link>
        ))}
      </div>
    </section>
  )
}
