import Link from 'next/link'
import { Badge } from '@hitly/ui'

const plugins = [
  {
    id: 'mastra',
    name: 'Mastra',
    status: 'Available',
    href: '/integrations/mastra',
    body: 'createHitlyApprovalStep() wraps suspend() and resume(). First-class plugin.',
  },
  {
    id: 'n8n',
    name: 'n8n',
    status: 'Coming soon',
    href: '/integrations/n8n',
    body: 'HTTP Request to Hitly, then Wait on webhook. Hitly POSTs $execution.resumeUrl.',
  },
  {
    id: 'langgraph',
    name: 'LangGraph',
    status: 'Coming soon',
    href: '/integrations/langgraph',
    body: 'Maps HumanInterrupt onto the Hitly envelope and resumes with HumanResponse.',
  },
  {
    id: 'temporal',
    name: 'Temporal',
    status: 'Coming soon',
    href: '/integrations/temporal',
    body: 'Activity creates the approval; condition() waits; Hitly sends hitly.decision.',
  },
]

export function PluginGrid() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="text-2xl font-semibold">Plugins</h2>
      <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
        We start with four frameworks. We will support any framework that has demand.
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
              <Badge variant={plugin.status === 'Available' ? 'success' : 'warning'}>{plugin.status}</Badge>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{plugin.body}</p>
          </Link>
        ))}
      </div>
    </section>
  )
}
