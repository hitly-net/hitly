import Link from 'next/link'
import { AppShell } from '@/components/app-shell'

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000'

export const metadata = { title: 'Connections' }

export default function ConnectionsPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Connections</h1>
      <p className="mt-2 text-sm text-zinc-500">Origin frameworks Hitly can resume.</p>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {[
          { id: 'mastra', name: 'Mastra', status: 'Available' },
          { id: 'n8n', name: 'n8n', status: 'Coming soon' },
          { id: 'langgraph', name: 'LangGraph', status: 'Coming soon' },
          { id: 'temporal', name: 'Temporal', status: 'Coming soon' },
        ].map((plugin) => (
          <div key={plugin.id} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{plugin.name}</h2>
              <span className="text-xs text-zinc-500">{plugin.status}</span>
            </div>
            <p className="mt-3 text-xs">
              <Link href={`${WEB_URL}/integrations/${plugin.id}`} className="underline">
                Open guide
              </Link>
            </p>
          </div>
        ))}
      </div>
    </AppShell>
  )
}
